/**
 * WSL search tooling (Windows host → WSL distro).
 *
 * Why: every `wsl.exe … bash -lc` spawn costs hundreds of ms (VM hop + login
 * profile). Search runs on every keystroke, so we:
 *  1. install a Linux `rg` + tiny scripts under `~/.cache/anchor` ONCE
 *     (no per-search `chmod` on a /mnt/c binary);
 *  2. run rg via `wsl.exe --exec` (no shell, no profile) in its own process
 *     group so cancel can kill the WSL-side process (no orphan rg);
 *  3. prefer a persistent helper (python3, JSON-lines over stdin/stdout) so a
 *     search costs zero wsl.exe spawns; fall back to (2) when unavailable.
 */
import { StringDecoder } from "node:string_decoder";
import type { RunOptions, RunResult } from "./types.js";
import { HostError } from "./types.js";

/** Directory (relative to $HOME) for installed search tools. */
export const WSL_TOOLS_DIR = ".cache/anchor";

/**
 * Process-group runner: prints its PID (== PGID under `setsid`) on stderr,
 * then execs the real command. Lets the host `kill -- -PGID` on cancel.
 */
export const WSL_GROUP_RUNNER_SCRIPT = `#!/bin/sh
printf '__ANCHOR_PGID:%s\\n' "$$" >&2
exec "$@"
`;

/**
 * Persistent search helper. Protocol (one JSON object per line):
 *   in : {"op":"run","id":"r1","cwd":"/repo","cmd":"rg","args":[...]}
 *        {"op":"cancel","id":"r1"}
 *   out: {"ev":"ready"}
 *        {"id":"r1","ev":"out","data":"..."}   (stdout, UTF-8 safe)
 *        {"id":"r1","ev":"err","data":"..."}   (stderr)
 *        {"id":"r1","ev":"exit","code":0}
 * Each run gets its own session/process group; cancel kills the group.
 */
export const WSL_SEARCH_HELPER_PY = `import codecs, json, os, signal, subprocess, sys, threading
lock = threading.Lock()
procs = {}
def emit(obj):
    line = json.dumps(obj, ensure_ascii=False) + "\\n"
    with lock:
        sys.stdout.write(line)
        sys.stdout.flush()
def pump(rid, stream, ev):
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    while True:
        chunk = os.read(stream.fileno(), 65536)
        if not chunk:
            break
        text = dec.decode(chunk)
        if text:
            emit({"id": rid, "ev": ev, "data": text})
    tail = dec.decode(b"", True)
    if tail:
        emit({"id": rid, "ev": ev, "data": tail})
def run(msg):
    rid = msg["id"]
    raw_in = msg.get("stdin")
    try:
        p = subprocess.Popen([msg["cmd"]] + list(msg.get("args") or []), cwd=msg.get("cwd") or "/",
            stdin=subprocess.PIPE if raw_in is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as e:
        emit({"id": rid, "ev": "err", "data": str(e)})
        emit({"id": rid, "ev": "exit", "code": 127})
        return
    if raw_in is not None and p.stdin is not None:
        try:
            p.stdin.write(raw_in.encode("utf-8") if isinstance(raw_in, str) else raw_in)
        except OSError:
            pass
        try:
            p.stdin.close()
        except OSError:
            pass
    procs[rid] = p
    t1 = threading.Thread(target=pump, args=(rid, p.stdout, "out"), daemon=True)
    t2 = threading.Thread(target=pump, args=(rid, p.stderr, "err"), daemon=True)
    t1.start(); t2.start()
    code = p.wait(); t1.join(); t2.join()
    procs.pop(rid, None)
    emit({"id": rid, "ev": "exit", "code": code if code >= 0 else 128 - code})
def cancel(rid):
    p = procs.get(rid)
    if p is None:
        return
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except OSError:
        pass
emit({"ev": "ready"})
for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        msg = json.loads(raw)
    except ValueError:
        continue
    if msg.get("op") == "run":
        threading.Thread(target=run, args=(msg,), daemon=True).start()
    elif msg.get("op") == "cancel":
        cancel(msg.get("id"))
for p in list(procs.values()):
    try:
        os.killpg(p.pid, signal.SIGTERM)
    except OSError:
        pass
`;

export interface WslSearchTools {
  home: string;
  /** Absolute Linux path of rg to use, or null when none is available. */
  rg: string | null;
  /** Absolute path of the process-group runner script. */
  runner: string;
  /** Absolute path of the helper script when python3 exists, else null. */
  helper: string | null;
  python: string | null;
}

/**
 * Bash script (fed via `bash -s` stdin — no -lc quoting layer) that installs
 * the tools once and prints `KEY=value` lines.
 */
export function buildWslInstallScript(bundledRg: string | null): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "set -u",
    `D="$HOME/${WSL_TOOLS_DIR}"`,
    'mkdir -p "$D"',
    `printf '%s' ${q(b64(WSL_GROUP_RUNNER_SCRIPT))} | base64 -d > "$D/run-group.sh"`,
    'chmod +x "$D/run-group.sh"',
    `printf '%s' ${q(b64(WSL_SEARCH_HELPER_PY))} | base64 -d > "$D/search-helper.py"`,
    'RG=""',
    bundledRg
      ? `if [ -f ${q(bundledRg)} ]; then if ! cmp -s ${q(bundledRg)} "$D/rg" 2>/dev/null; then cp -f ${q(bundledRg)} "$D/rg.tmp" && chmod +x "$D/rg.tmp" && mv -f "$D/rg.tmp" "$D/rg"; fi; fi`
      : ":",
    'if [ -x "$D/rg" ] && "$D/rg" --version >/dev/null 2>&1; then RG="$D/rg"; fi',
    'if [ -z "$RG" ]; then RG="$(command -v rg 2>/dev/null || true)"; fi',
    'PY="$(command -v python3 2>/dev/null || true)"',
    'echo "HOME=$HOME"',
    'echo "RG=$RG"',
    'echo "PY=$PY"',
    "",
  ].join("\n");
}

export function parseWslInstallOutput(stdout: string): WslSearchTools {
  const kv = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(HOME|RG|PY)=(.*)$/);
    if (m) kv.set(m[1]!, m[2]!.trim());
  }
  const home = kv.get("HOME");
  if (!home) throw new HostError("failed", "WSL search tool install failed");
  const dir = `${home.replace(/\/+$/, "")}/${WSL_TOOLS_DIR}`;
  const python = kv.get("PY") || null;
  return {
    home,
    rg: kv.get("RG") || null,
    runner: `${dir}/run-group.sh`,
    helper: python ? `${dir}/search-helper.py` : null,
    python,
  };
}

/** `wsl.exe` argv for a no-shell exec (no login profile, no -c parsing). */
export function buildWslExecArgs(
  base: string[],
  cwd: string,
  command: string,
  args: string[],
): string[] {
  return [...base, "--cd", cwd, "--exec", command, ...args];
}

/** argv to run `command` in its own process group via the runner script. */
export function buildWslGroupExecArgs(
  base: string[],
  cwd: string,
  runner: string,
  command: string,
  args: string[],
): string[] {
  return buildWslExecArgs(base, cwd, "setsid", ["-w", runner, command, ...args]);
}

/** argv to TERM a WSL process group. */
export function buildWslKillGroupArgs(base: string[], pgid: number): string[] {
  return [...base, "--exec", "kill", "-TERM", "--", `-${pgid}`];
}

/** Extract + strip the runner's PGID marker from stderr. */
export function takePgidMarker(stderr: string): { pgid: number | null; rest: string } {
  const m = stderr.match(/__ANCHOR_PGID:(\d+)\r?\n?/);
  if (!m) return { pgid: null, rest: stderr };
  return { pgid: Number(m[1]), rest: stderr.replace(m[0], "") };
}

/** Minimal process surface the helper client needs (mockable in tests). */
export interface HelperProcess {
  stdin: { write(data: string): unknown } | null;
  stdout: { on(ev: "data", cb: (chunk: Buffer) => void): unknown } | null;
  on(ev: "exit" | "error", cb: (...a: unknown[]) => void): unknown;
  kill(): unknown;
}

interface PendingRun {
  stdout: string;
  stderr: string;
  settle: (r: RunResult | Error) => void;
  opts?: RunOptions;
}

/**
 * Client for the persistent JSON-lines helper. One process serves many runs;
 * if it dies, pending runs reject and `alive` turns false (caller falls back).
 */
export class WslSearchHelperClient {
  private seq = 0;
  private buf = "";
  private readonly dec = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRun>();
  private readyResolve!: () => void;
  readonly ready: Promise<void>;
  alive = true;

  constructor(private readonly proc: HelperProcess) {
    this.ready = new Promise((res) => {
      this.readyResolve = res;
    });
    proc.stdout?.on("data", (chunk) => this.onData(chunk));
    const die = () => this.die();
    proc.on("exit", die);
    proc.on("error", die);
  }

  private die(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const p of this.pending.values()) {
      p.settle(new HostError("failed", "WSL search helper exited"));
    }
    this.pending.clear();
  }

  dispose(): void {
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.die();
  }

  private send(obj: unknown): void {
    this.proc.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buf += this.dec.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { ev?: string; id?: string; data?: string; code?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.ev === "ready") {
        this.readyResolve();
        continue;
      }
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p || !msg.id) continue;
      if (msg.ev === "out" && typeof msg.data === "string") {
        p.stdout += msg.data;
        try {
          p.opts?.onStdoutChunk?.(msg.data, p.stdout);
        } catch {
          // ignore
        }
        if (p.opts?.earlyExit?.(p.stdout, p.stderr)) {
          this.cancel(msg.id);
          this.pending.delete(msg.id);
          p.settle({ stdout: p.stdout, stderr: p.stderr, code: 0, earlyExit: true });
        }
      } else if (msg.ev === "err" && typeof msg.data === "string") {
        p.stderr += msg.data;
      } else if (msg.ev === "exit") {
        this.pending.delete(msg.id);
        p.settle({ stdout: p.stdout, stderr: p.stderr, code: msg.code ?? 1 });
      }
    }
  }

  private cancel(id: string): void {
    try {
      this.send({ op: "cancel", id });
    } catch {
      // ignore
    }
  }

  run(cwd: string, command: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    if (!this.alive) {
      return Promise.reject(new HostError("failed", "WSL search helper not running"));
    }
    const id = `r${++this.seq}`;
    const signal = opts?.signal;
    if (signal?.aborted) {
      return Promise.resolve({ stdout: "", stderr: "", code: 0, aborted: true });
    }
    return new Promise<RunResult>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        const p = this.pending.get(id);
        this.cancel(id);
        this.pending.delete(id);
        entry.settle({
          stdout: p?.stdout ?? "",
          stderr: p?.stderr ?? "",
          code: 0,
          aborted: true,
        });
      };
      const entry: PendingRun = {
        stdout: "",
        stderr: "",
        opts,
        settle: (r) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (r instanceof Error) reject(r);
          else resolve(r);
        },
      };
      this.pending.set(id, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = opts?.timeoutMs ?? 45_000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.cancel(id);
          this.pending.delete(id);
          entry.settle(
            new HostError("timeout", `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`),
          );
        }, timeoutMs);
      }
      const payload: {
        op: string;
        id: string;
        cwd: string;
        cmd: string;
        args: string[];
        stdin?: string;
      } = { op: "run", id, cwd, cmd: command, args };
      if (opts?.stdin != null) payload.stdin = opts.stdin;
      this.send(payload);
    });
  }
}
