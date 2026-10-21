import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { HostError } from "./types.js";

/**
 * Persistent remote shell for cheap read-only file operations over system
 * OpenSSH (Explorer listings, stat, file reads).
 *
 * Spawning `ssh` per operation costs a full TCP + key exchange + auth
 * handshake (~10 round trips) and competes for the per-alias spawn budget with
 * git/search/agent probes. One long-lived `ssh … bash -c <loop>` session turns
 * each request into a single round trip. It is started with exactly the same
 * hardened ssh arguments as every other command, so host-key verification and
 * the no-ControlMaster policy are unchanged.
 *
 * Protocol (bash only, LC_ALL=C so lengths are bytes):
 *   request:  "<id> <scriptBytes>\n<script>"
 *   response: "<id> <exitCode> <stdoutBytes> <stderrBytes>\n<stdout><stderr>"
 * Each script runs in a fresh subshell in $HOME with stdin from /dev/null.
 * Scripts are never NUL-bearing (shellQuote rejects NUL).
 */
export const READY_MARKER = "__ANCHOR_SSH_HELPER_READY__";

export const HELPER_SCRIPT = [
  "export LC_ALL=C",
  // `read -N` needs bash >= 4.1 (macOS /bin/bash is 3.2): exit, caller falls back.
  '[ "${BASH_VERSINFO[0]:-0}" -gt 4 ] || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 1 ]; } || exit 98',
  'cd -- "$HOME" 2>/dev/null || cd /',
  'd=$(mktemp -d 2>/dev/null || mktemp -d -t anchor) || exit 97',
  `trap 'rm -rf -- "$d"' EXIT`,
  `printf '%s\\n' ${READY_MARKER}`,
  "while IFS=' ' read -r id len; do",
  '  [ -n "$len" ] || break',
  '  s=""; if [ "$len" -gt 0 ]; then IFS= read -r -N "$len" s || break; fi',
  '  ( eval "$s" ) >"$d/o" 2>"$d/e" </dev/null; c=$?',
  `  printf '%s %s %s %s\\n' "$id" "$c" "$(wc -c <"$d/o")" "$(wc -c <"$d/e")"`,
  '  cat -- "$d/o" "$d/e"',
  "done",
].join("\n");

export interface HelperProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface HelperResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface Pending {
  id: number;
  resolve: (r: HelperResult) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const HEADER = /^(\d+) (-?\d+) +(\d+) +(\d+)$/;

export class OpenSshHelperClient {
  private buf: Buffer = Buffer.alloc(0);
  private ready = false;
  private dead: HostError | null = null;
  private nextId = 1;
  /** FIFO: the remote loop answers strictly in request order. */
  private readonly queue: Pending[] = [];
  private stderrTail = "";
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;

  constructor(
    private readonly child: HelperProcess,
    private readonly describeExit: (stderr: string) => HostError = (stderr) =>
      new HostError("disconnected", "SSH helper exited.", stderr.trim() || undefined),
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A rejected-but-unawaited ready promise must not crash the process.
    this.readyPromise.catch(() => undefined);
    const errDec = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + errDec.write(chunk)).slice(-8 * 1024);
    });
    child.stdin?.on("error", () => this.fail(this.describeExit(this.stderrTail)));
    child.on("error", (err) => this.fail(new HostError("failed", "Failed to start SSH helper.", err.message)));
    child.on("close", () => this.fail(this.describeExit(this.stderrTail)));
  }

  get alive(): boolean {
    return this.dead === null;
  }

  /** Requests sent but not yet answered. */
  get pending(): number {
    return this.queue.length;
  }

  /** Resolves once the remote loop is running (login noise skipped). */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  exec(script: string, timeoutMs = 45_000): Promise<HelperResult> {
    if (this.dead) return Promise.reject(this.dead);
    if (script.includes("\0")) {
      return Promise.reject(new HostError("failed", "SSH helper scripts cannot contain NUL bytes."));
    }
    const body = Buffer.from(script, "utf8");
    const id = this.nextId++;
    return new Promise<HelperResult>((resolve, reject) => {
      const p: Pending = { id, resolve, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          // A stuck request blocks every later one: drop the whole session.
          this.fail(new HostError("timeout", `SSH helper request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.queue.push(p);
      try {
        this.child.stdin?.write(Buffer.concat([Buffer.from(`${id} ${body.length}\n`), body]));
      } catch (err) {
        this.fail(new HostError("disconnected", "Cannot write to SSH helper.", err instanceof Error ? err.message : String(err)));
      }
    });
  }

  dispose(): void {
    this.fail(new HostError("disconnected", "SSH helper closed."));
  }

  private fail(error: HostError): void {
    if (this.dead) return;
    this.dead = error;
    this.rejectReady(error);
    for (const p of this.queue.splice(0)) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    try { this.child.kill("SIGTERM"); } catch { /* already exited */ }
  }

  private onData(chunk: Buffer): void {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.ready) {
      const marker = Buffer.from(`${READY_MARKER}\n`);
      const at = this.buf.indexOf(marker);
      if (at < 0) {
        // Keep only enough tail to find a marker split across chunks.
        if (this.buf.length > 64 * 1024) this.buf = this.buf.subarray(this.buf.length - marker.length);
        return;
      }
      this.buf = this.buf.subarray(at + marker.length);
      this.ready = true;
      this.resolveReady();
    }
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const header = HEADER.exec(this.buf.subarray(0, nl).toString("latin1").trim().replace(/\s+/g, " "));
      if (!header) {
        this.fail(new HostError("failed", "SSH helper protocol error."));
        return;
      }
      const outLen = Number(header[3]);
      const errLen = Number(header[4]);
      const total = nl + 1 + outLen + errLen;
      if (this.buf.length < total) return;
      const out = this.buf.subarray(nl + 1, nl + 1 + outLen);
      const err = this.buf.subarray(nl + 1 + outLen, total);
      this.buf = this.buf.subarray(total);
      const p = this.queue.shift();
      if (!p || p.id !== Number(header[1])) {
        this.fail(new HostError("failed", "SSH helper response out of order."));
        return;
      }
      clearTimeout(p.timer);
      p.resolve({ stdout: out.toString("utf8"), stderr: err.toString("utf8"), code: Number(header[2]) });
    }
  }
}
