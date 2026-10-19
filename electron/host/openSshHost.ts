import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawnLocalPty } from "./localPty.js";
import { HostError } from "./types.js";
import type {
  DirEntry,
  HostSession,
  PtyHandle,
  PtySpawnOptions,
  RunOptions,
  RunResult,
  StatResult,
} from "./types.js";

export interface OpenSshHostOptions {
  profileId: string;
  /** An OpenSSH config alias, passed unchanged to the local ssh executable. */
  configHost: string;
}

interface ActiveRun {
  stop: () => void;
  done: Promise<void>;
}

const STOP_GRACE_MS = 250;
const PTY_BUFFER_LIMIT = 512 * 1024;

/**
 * Local system OpenSSH transport. OpenSSH owns config evaluation, agent/key
 * access, proxies, and known-host verification; no credentials are read here.
 * Remote filesystem operations require bash and ordinary GNU/BSD utilities.
 */
export class OpenSshHostSession implements HostSession {
  readonly id = `openssh-${randomUUID().slice(0, 8)}`;
  readonly kind = "ssh" as const;
  readonly profileId: string;
  readonly configHost: string;
  workspaceRoot: string | null = null;

  private disposed = false;
  private readonly runs = new Set<ActiveRun>();
  private readonly ptys = new Set<PtyHandle>();

  constructor(opts: OpenSshHostOptions) {
    if (!opts.configHost || opts.configHost.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(opts.configHost)) {
      throw new HostError("failed", "An SSH config host must be a nonempty alias without whitespace or a leading dash.");
    }
    this.profileId = opts.profileId;
    this.configHost = opts.configHost;
  }

  private assertActive(): void {
    if (this.disposed) throw new HostError("disconnected", "This SSH session has been closed. Reconnect to continue.");
  }

  private sshArgs(terminal: boolean, remoteCommand: string): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "VerifyHostKeyDNS=no",
      "-o", "UpdateHostKeys=no",
      // Existing masters can bypass a new handshake and host-key verification.
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-o", "ControlPersist=no",
      // A config alias may otherwise replace/suppress the command or detach ssh.
      "-o", "RemoteCommand=none",
      "-o", "SessionType=default",
      "-o", "ForkAfterAuthentication=no",
      "-o", "StdinNull=no",
      "-o", `RequestTTY=${terminal ? "force" : "no"}`,
      "-o", "PermitLocalCommand=no",
      "-o", "ClearAllForwardings=yes",
      terminal ? "-tt" : "-T",
      "--", this.configHost, remoteCommand,
    ];
  }

  async run(cwd: string, command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    this.assertActive();
    if (opts.signal?.aborted) return { stdout: "", stderr: "", code: 0, aborted: true };
    const script = `cd -- ${remotePath(cwd || "/")} && exec ${[command, ...args].map(shellQuote).join(" ")}`;
    const sshArgs = this.sshArgs(false, `bash -c ${shellQuote(script)}`);

    return new Promise<RunResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("ssh", sshArgs, {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          // Include a native ProxyCommand's descendants in local cancellation.
          detached: process.platform !== "win32",
        });
      } catch (err) {
        reject(spawnError(err));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let closed = false;
      let stopping = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      let markDone!: () => void;
      const active: ActiveRun = {
        stop: () => fail(new HostError("disconnected", "SSH session closed while a command was running.")),
        done: new Promise<void>((done) => { markDone = done; }),
      };

      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const release = () => {
        if (closed) return;
        closed = true;
        clearTimeout(killTimer);
        this.runs.delete(active);
        markDone();
      };
      const sendSignal = (signal: NodeJS.Signals) => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The group may already have exited; try the child itself as well.
          }
        }
        try { child.kill(signal); } catch { /* Already exited. */ }
      };
      const terminate = () => {
        if (closed || stopping) return;
        stopping = true;
        child.stdin?.destroy();
        sendSignal("SIGTERM");
        killTimer = setTimeout(() => {
          sendSignal("SIGKILL");
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          release();
        }, STOP_GRACE_MS);
        killTimer.unref?.();
      };
      const finish = (code: number, flags: Pick<RunResult, "aborted" | "earlyExit"> = {}) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ stdout, stderr, code, ...flags });
      };
      const fail = (error: HostError) => {
        if (settled) return;
        settled = true;
        cleanup();
        terminate();
        reject(error);
      };
      const onAbort = () => {
        if (settled) return;
        finish(0, { aborted: true });
        terminate();
      };

      this.runs.add(active);
      child.on("error", (err) => {
        fail(spawnError(err));
        // A failed spawn has no process to await or kill.
        if (!child.pid) release();
      });
      child.on("close", (code) => {
        // close means this process has already exited; reporting its failure
        // must not signal a potentially recycled process id.
        release();
        if (!settled) {
          const tail = outDecoder.end();
          stdout += tail;
          stderr += errDecoder.end();
          if (tail) {
            try { opts.onStdoutChunk?.(tail, stdout); } catch { /* Observers cannot break cleanup. */ }
          }
          if (code === 255) fail(connectionError(this.configHost, stderr));
          else finish(code ?? 1);
        }
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        const text = outDecoder.write(chunk);
        if (!text) return;
        stdout += text;
        try { opts.onStdoutChunk?.(text, stdout); } catch { /* Observer only. */ }
        if (settled) return; // A chunk observer may synchronously abort the run.
        try {
          if (opts.earlyExit?.(stdout, stderr)) {
            finish(0, { earlyExit: true });
            terminate();
          }
        } catch (err) {
          fail(new HostError("failed", "SSH output callback failed.", errorMessage(err)));
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!settled) stderr += errDecoder.write(chunk);
      });
      // Remote commands can exit before consuming their input.
      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE" && err.code !== "ECONNRESET") {
          fail(new HostError("failed", "Cannot write to SSH command stdin.", err.message));
        }
      });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) { onAbort(); return; }
      const timeoutMs = opts.timeoutMs ?? 45_000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => fail(new HostError("timeout", `SSH command timed out after ${timeoutMs}ms: ${command}`)), timeoutMs);
      }
      // Always send EOF, including when stdin was omitted, so readers cannot hang.
      try { child.stdin?.end(opts.stdin ?? ""); }
      catch (err) { fail(new HostError("failed", "Cannot write to SSH command stdin.", errorMessage(err))); }
    });
  }

  private async fileCommand(script: string, message: string, stdin?: string): Promise<string> {
    const result = await this.run("~", "bash", ["-c", `export LC_ALL=C; ${script}`], { stdin });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      if (/permission denied|operation not permitted|__ANCHOR_PERMISSION__/i.test(detail)) {
        throw new HostError("permission", message, detail);
      }
      if (/no such file or directory|not a directory/i.test(detail)) {
        throw new HostError("not_found", message, detail);
      }
      throw new HostError("failed", message, detail || `Remote command exited with code ${result.code}`);
    }
    return result.stdout;
  }

  async readFile(filePath: string): Promise<string> {
    return this.fileCommand(`exec cat -- ${remotePath(filePath)}`, `Cannot read file: ${filePath}`);
  }

  async writeFile(filePath: string, data: string): Promise<void> {
    await this.fileCommand(
      `mkdir -p -- ${remotePath(path.posix.dirname(filePath))} && cat > ${remotePath(filePath)}`,
      `Cannot write file: ${filePath}`, data,
    );
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    const output = await this.fileCommand(
      `cd -- ${remotePath(dirPath)} || exit $?; ` +
      `if [ ! -r . ] || [ ! -x . ]; then printf '__ANCHOR_PERMISSION__\\n' >&2; exit 73; fi; ` +
      `unset GLOBIGNORE; set +f; shopt -u failglob; shopt -s dotglob nullglob; for item in *; do ` +
      `if [ -d "$item" ]; then printf 'd\\0%s\\0' "$item"; else printf 'f\\0%s\\0' "$item"; fi; done`,
      `Cannot list directory: ${dirPath}`,
    );
    if (!output) return [];
    const fields = output.split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0) {
      throw new HostError("failed", `Invalid directory listing from SSH: ${dirPath}`);
    }
    const entries: DirEntry[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      const kind = fields[i];
      const name = fields[i + 1];
      if ((kind !== "d" && kind !== "f") || !name || name === "." || name === ".." || name.includes("/")) {
        throw new HostError("failed", `Invalid directory entry from SSH: ${dirPath}`);
      }
      entries.push({ name, type: kind === "d" ? "dir" : "file" });
    }
    return entries.sort((a, b) => a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async stat(filePath: string): Promise<StatResult> {
    const output = await this.fileCommand(
      `p=${remotePath(filePath)}; kind=other; ` +
      `if [ -d "$p" ]; then kind=dir; elif [ -f "$p" ]; then kind=file; fi; ` +
      `meta=$(stat -L -c '%s|%Y' -- "$p" 2>/dev/null) || ` +
      `{ meta=$(stat -L -f '%z|%m' "$p") || exit $?; }; ` +
      `printf '%s|%s\\n' "$kind" "$meta"`,
      `Cannot stat: ${filePath}`,
    );
    const match = /^(file|dir|other)\|(\d+)\|(-?\d+)\n?$/.exec(output);
    if (!match || !Number.isSafeInteger(Number(match[2])) || !Number.isFinite(Number(match[3]) * 1000)) {
      throw new HostError("failed", `Invalid file metadata from SSH: ${filePath}`);
    }
    return { isFile: match[1] === "file", isDir: match[1] === "dir", size: Number(match[2]), mtimeMs: Number(match[3]) * 1000 };
  }

  async exists(filePath: string): Promise<boolean> {
    try { await this.stat(filePath); return true; }
    catch (err) {
      if (err instanceof HostError && err.code === "not_found") return false;
      throw err;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    await this.fileCommand(`exec mkdir -p -- ${remotePath(dirPath)}`, `Cannot create directory: ${dirPath}`);
  }

  async remove(targetPath: string): Promise<void> {
    await this.fileCommand(`exec rm -rf -- ${remotePath(targetPath)}`, `Cannot delete: ${targetPath}`);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.fileCommand(`exec mv -- ${remotePath(oldPath)} ${remotePath(newPath)}`, `Cannot rename: ${oldPath} → ${newPath}`);
  }

  async copyPath(src: string, dst: string): Promise<void> {
    await this.fileCommand(`exec cp -R -- ${remotePath(src)} ${remotePath(dst)}`, `Cannot copy: ${src} → ${dst}`);
  }

  async openPty(cwd: string, cols: number, rows: number, opts?: PtySpawnOptions): Promise<PtyHandle> {
    this.assertActive();
    const exports = Object.entries(opts?.env ?? {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
    const command = opts?.command
      ? [opts.command, ...(opts.args ?? [])].map(shellQuote).join(" ")
      : '"${SHELL:-/bin/bash}" -l';
    const script = [`cd -- ${remotePath(cwd || this.workspaceRoot || "~")}`, ...exports, `exec ${command}`].join(" && ");
    let raw: PtyHandle;
    try {
      // cwd is local here. Never hand node-pty a remote filesystem path.
      ({ handle: raw } = await spawnLocalPty(process.cwd(), cols, rows, {
        shell: "ssh",
        args: this.sshArgs(true, `bash -lic ${shellQuote(script)}`),
      }));
    } catch (err) {
      throw spawnError(err);
    }
    if (this.disposed) {
      raw.kill();
      throw new HostError("disconnected", "SSH session closed while its terminal was starting.");
    }

    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number) => void>();
    let pendingData = "";
    let diagnosticTail = "";
    let exitCode: number | undefined;
    let alive = true;
    const emitData = (data: string) => {
      if (!dataListeners.size) pendingData = (pendingData + data).slice(-PTY_BUFFER_LIMIT);
      else for (const listener of dataListeners) listener(data);
    };
    const handle: PtyHandle = {
      id: raw.id,
      write: (data) => { if (alive) raw.write(data); },
      resize: (c, r) => { if (alive) raw.resize(c, r); },
      onData: (listener) => {
        dataListeners.add(listener);
        if (pendingData) { const data = pendingData; pendingData = ""; listener(data); }
      },
      onExit: (listener) => { exitListeners.add(listener); if (exitCode !== undefined) listener(exitCode); },
      kill: () => {
        if (!alive) return;
        alive = false;
        this.ptys.delete(handle);
        raw.kill();
      },
    };
    this.ptys.add(handle);
    raw.onData((data) => {
      diagnosticTail = (diagnosticTail + data).slice(-16 * 1024);
      emitData(data);
    });
    raw.onExit((code) => {
      alive = false;
      exitCode = code;
      this.ptys.delete(handle);
      if (code === 255) emitData(`\r\n${connectionError(this.configHost, diagnosticTail).message}\r\n`);
      for (const listener of exitListeners) listener(code);
    });
    return handle;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.workspaceRoot = null;
    const runs = [...this.runs];
    for (const run of runs) run.stop();
    for (const pty of [...this.ptys]) {
      try { pty.kill(); } catch { /* Continue cleaning up other terminals. */ }
    }
    this.ptys.clear();
    await Promise.all(runs.map((run) => run.done));
  }
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new HostError("failed", "SSH command arguments and paths cannot contain NUL bytes.");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Preserve POSIX backslashes/newlines and expand only the current user's ~/ prefix. */
function remotePath(value: string): string {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"$HOME"/${shellQuote(value.slice(2))}`;
  return shellQuote(value.startsWith("-") ? `./${value}` : value || ".");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnError(error: unknown): HostError {
  const detail = errorMessage(error);
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || /executable not found|File not found|ENOENT/i.test(detail)) {
    return new HostError("not_found", 'System OpenSSH executable "ssh" was not found. Install OpenSSH and make it available on PATH, then retry.', detail);
  }
  return new HostError("failed", "Failed to start system OpenSSH.", detail);
}

function connectionError(alias: string, detail: string): HostError {
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .+ host key is known|Offending .+ key/i.test(detail)) {
    return new HostError("disconnected", `SSH host key verification failed for "${alias}". Verify the server fingerprint with a trusted source, then connect using ssh ${shellQuote(alias)} in a normal terminal to review or update the trusted key, and retry.`, detail.trim());
  }
  if (/permission denied|no supported authentication methods|too many authentication failures|signing failed|agent refused operation/i.test(detail)) {
    return new HostError("disconnected", `SSH authentication failed for "${alias}". Config-host connections use key or agent authentication without prompts. Load encrypted keys into your SSH agent with ssh-add, or use a manual SSH profile for password authentication.`, detail.trim());
  }
  return new HostError("disconnected", `OpenSSH could not connect to "${alias}"${detail.trim() ? `: ${detail.trim()}` : ". Check the alias, network, and SSH authentication in a normal terminal."}`, detail.trim());
}
