import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type {
  DirEntry,
  HostSession,
  PtyHandle,
  RunOptions,
  RunResult,
  StatResult,
} from "./types.js";
import { HostError } from "./types.js";
import { hostNormalize } from "./paths.js";
import { spawnLocalPty } from "./localPty.js";

export interface WslHostOptions {
  profileId?: string;
  /** WSL distro name; omit for default distro. */
  distro?: string;
  /** Login user inside WSL (optional; uses distro default). */
  user?: string;
}

/**
 * Windows → WSL HostSession.
 *
 * Paths stay POSIX (execution-end). Fast path for fs uses Windows UNC
 * `\\wsl$\<distro>\…` so listDir/readFile don't spawn wsl.exe per click.
 * Absolute symlinks and other UNC gaps fall back to `wsl.exe` (Linux fs).
 * `run` / PTY always go through wsl.exe.
 */
export function buildWslAgentShellArgs(
  command: string,
  args: string[],
  env?: Record<string, string>,
): string[] {
  const cmdline = posixShellCommand(command, args);
  const exports = posixExportEnv(env);
  const body = exports ? `${exports}; exec ${cmdline}` : `exec ${cmdline}`;
  return ["--", "bash", "-lic", body];
}

export class WslHostSession implements HostSession {
  readonly id: string;
  readonly kind = "wsl" as const;
  readonly profileId: string;
  readonly distro?: string;
  readonly user?: string;
  workspaceRoot: string | null = null;
  private openPtys = new Set<PtyHandle>();
  /** Resolved distro for UNC paths (cached). */
  private uncDistro: string | null = null;
  private uncDistroPromise: Promise<string> | null = null;

  constructor(opts: WslHostOptions = {}) {
    this.id = `wsl-${randomUUID().slice(0, 8)}`;
    this.profileId = opts.profileId ?? "wsl-default";
    this.distro = opts.distro?.trim() || undefined;
    this.user = opts.user?.trim() || undefined;
    if (this.distro) this.uncDistro = this.distro;
  }

  private wslBaseArgs(): string[] {
    const args: string[] = [];
    if (this.distro) {
      args.push("-d", this.distro);
    }
    if (this.user) {
      args.push("-u", this.user);
    }
    return args;
  }

  private resolveWslExe(): string {
    const candidates = [
      process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\wsl.exe`
        : null,
      "C:\\Windows\\System32\\wsl.exe",
      "wsl.exe",
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      try {
        if (c === "wsl.exe" || fs.existsSync(c)) return c;
      } catch {
        // continue
      }
    }
    return "wsl.exe";
  }

  private async resolveUncDistro(): Promise<string> {
    if (this.uncDistro) return this.uncDistro;
    if (this.uncDistroPromise) return this.uncDistroPromise;
    this.uncDistroPromise = (async () => {
      if (this.distro) {
        this.uncDistro = this.distro;
        return this.distro;
      }
      // Default distro: first from `wsl -l -q`, else common fallback.
      const list = await listWslDistros();
      const name = list[0] || "Ubuntu";
      this.uncDistro = name;
      return name;
    })();
    try {
      return await this.uncDistroPromise;
    } finally {
      this.uncDistroPromise = null;
    }
  }

  /**
   * Map POSIX WSL path → Windows UNC under \\wsl$\distro\...
   * UI/API still use POSIX; UNC is internal only.
   * Public so content search can run Windows ripgrep against WSL trees
   * without spawning wsl.exe (Linux `rg` is often missing).
   */
  async toWindowsUnc(posixPath: string): Promise<string> {
    return this.toUnc(posixPath);
  }

  private async toUnc(posixPath: string): Promise<string> {
    const p = hostNormalize("wsl", posixPath);
    const distro = await this.resolveUncDistro();
    // `/home/u/repo` → `\\wsl$\Ubuntu\home\u\repo`
    const relative = p === "/" ? "" : p.replace(/^\//, "").replace(/\//g, "\\");
    return relative
      ? `\\\\wsl$\\${distro}\\${relative}`
      : `\\\\wsl$\\${distro}\\`;
  }

  private mapFsError(err: unknown, fallback: string): HostError {
    if (err instanceof HostError) return err;
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      return new HostError("not_found", fallback, e.message);
    }
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      return new HostError("permission", fallback, e.message);
    }
    // UNC sometimes returns EISDIR/EINVAL for Linux absolute symlinks.
    if (e?.code === "EISDIR" || e?.code === "EINVAL" || e?.code === "UNKNOWN") {
      return new HostError("failed", fallback, e.message);
    }
    return new HostError(
      "failed",
      fallback,
      e?.message ?? String(err),
    );
  }

  private escapeSingle(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  private async runBash(script: string, cwd = "/"): Promise<RunResult> {
    return this.run(cwd, "bash", ["-lc", script]);
  }

  /** True when UNC failed in a way that often means symlink / special file. */
  private isUncGap(err: unknown): boolean {
    const e = err as NodeJS.ErrnoException;
    const code = e?.code;
    return (
      code === "ENOENT" ||
      code === "EISDIR" ||
      code === "EINVAL" ||
      code === "EPERM" ||
      code === "EACCES" ||
      code === "UNKNOWN"
    );
  }

  /**
   * Run a command inside WSL via login shell (PATH + env from profile).
   * Default 45s timeout so a hung `git status` cannot wedge the host forever.
   *
   * NOTE: the command + args are passed through `posixShellCommand` into one
   * `bash -lc '<script>'` string, so scripts containing `'`, `;`, `()`, `$var`,
   * or `{} -exec` are mangled by the double-shell quoting layer. For anything
   * non-trivial, pass the script via `opts.stdin` and invoke `bash -s` — that
   * bypasses the `-lc` quoting layer entirely and handles symlinks/parens.
   */
  async run(
    cwd: string,
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<RunResult> {
    const wsl = this.resolveWslExe();
    const safeCwd = hostNormalize("wsl", cwd || "/");
    const cmdline = posixShellCommand(command, args);
    const wslArgs = [
      ...this.wslBaseArgs(),
      "--cd",
      safeCwd,
      "--",
      "bash",
      "-lc",
      cmdline,
    ];
    return spawnCapture(
      wsl,
      wslArgs,
      opts?.timeoutMs ?? 45_000,
      opts?.stdin,
      opts?.earlyExit,
      opts?.onStdoutChunk,
    );
  }

  async readFile(filePath: string): Promise<string> {
    const p = hostNormalize("wsl", filePath);
    try {
      const unc = await this.toUnc(p);
      return await fsp.readFile(unc, "utf8");
    } catch (err) {
      if (!this.isUncGap(err)) {
        throw this.mapFsError(err, `Cannot read file: ${p}`);
      }
      // Absolute Linux symlinks are invisible/broken through \\wsl$\ — use cat.
      const r = await this.runBash(
        `if [ ! -e ${this.escapeSingle(p)} ] && [ ! -L ${this.escapeSingle(p)} ]; then echo '__AC_ENOENT__' >&2; exit 44; fi; cat ${this.escapeSingle(p)}`,
      );
      if (r.code === 44 || /__AC_ENOENT__/.test(r.stderr)) {
        throw new HostError("not_found", `Cannot read file: ${p}`, r.stderr);
      }
      if (r.code !== 0) {
        throw new HostError(
          "failed",
          `Cannot read file: ${p}`,
          r.stderr || r.stdout,
        );
      }
      return r.stdout;
    }
  }

  async writeFile(filePath: string, data: string): Promise<void> {
    const p = hostNormalize("wsl", filePath);
    try {
      const unc = await this.toUnc(p);
      const parent = path.win32.dirname(unc);
      await fsp.mkdir(parent, { recursive: true });
      await fsp.writeFile(unc, data, "utf8");
      return;
    } catch {
      // UNC mkdir/write often fails for nested trees / 9P — use Linux shell.
    }
    const dir = p.includes("/")
      ? p.slice(0, p.lastIndexOf("/")) || "/"
      : "/";
    const b64 = Buffer.from(data, "utf8").toString("base64");
    // bash -s + stdin avoids double-quoting issues in run()'s -lc path.
    const script = `mkdir -p ${this.escapeSingle(dir)} && printf '%s' ${this.escapeSingle(b64)} | base64 -d > ${this.escapeSingle(p)}\n`;
    const r = await this.run(dir === "/" ? "/" : dir, "bash", ["-s"], {
      stdin: script,
    });
    if (r.code !== 0) {
      throw new HostError(
        "failed",
        `Cannot write file: ${p}`,
        r.stderr || r.stdout,
      );
    }
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    const p = hostNormalize("wsl", dirPath);
    try {
      const unc = await this.toUnc(p);
      const names = await fsp.readdir(unc, { withFileTypes: true });
      const entries: DirEntry[] = [];
      for (const d of names) {
        let type: "file" | "dir" = "file";
        if (d.isDirectory()) {
          type = "dir";
        } else if (d.isSymbolicLink()) {
          // Prefer Linux view: absolute symlinks often fail UNC stat.
          try {
            const st = await fsp.stat(path.win32.join(unc, d.name));
            type = st.isDirectory() ? "dir" : "file";
          } catch {
            // Keep as file so the tree still shows the name (open may use wsl fallback).
            type = "file";
          }
        } else if (!d.isFile()) {
          continue;
        }
        entries.push({ name: d.name, type });
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return entries;
    } catch (err) {
      throw this.mapFsError(err, `Cannot list directory: ${p}`);
    }
  }

  async stat(filePath: string): Promise<StatResult> {
    const p = hostNormalize("wsl", filePath);
    try {
      const unc = await this.toUnc(p);
      const st = await fsp.stat(unc);
      return {
        isFile: st.isFile(),
        isDir: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch (err) {
      if (!this.isUncGap(err)) {
        throw this.mapFsError(err, `Cannot stat: ${p}`);
      }
      // Follow symlinks inside WSL (UNC cannot resolve absolute link targets).
      const r = await this.runBash(
        `if [ ! -e ${this.escapeSingle(p)} ] && [ ! -L ${this.escapeSingle(p)} ]; then echo '__AC_ENOENT__' >&2; exit 44; fi; ` +
          `if [ -d ${this.escapeSingle(p)} ]; then printf 'dir|'; elif [ -f ${this.escapeSingle(p)} ] || [ -L ${this.escapeSingle(p)} ]; then printf 'file|'; else printf 'other|'; fi; ` +
          `stat -c '%s|%Y' ${this.escapeSingle(p)} 2>/dev/null || stat -f '%z|%m' ${this.escapeSingle(p)}`,
      );
      if (r.code === 44 || /__AC_ENOENT__/.test(r.stderr)) {
        throw new HostError("not_found", `Cannot stat: ${p}`, r.stderr);
      }
      if (r.code !== 0) {
        throw new HostError(
          "failed",
          `Cannot stat: ${p}`,
          r.stderr || r.stdout,
        );
      }
      const line = r.stdout.trim().split("\n")[0] ?? "";
      const [kindRaw, sizeRaw, mtimeRaw] = line.split("|");
      const isDir = (kindRaw ?? "").startsWith("dir");
      return {
        isFile: !isDir,
        isDir,
        size: Number(sizeRaw) || 0,
        mtimeMs: (Number(mtimeRaw) || 0) * 1000,
      };
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = hostNormalize("wsl", filePath);
    try {
      const unc = await this.toUnc(p);
      await fsp.access(unc);
      return true;
    } catch (err) {
      if (!this.isUncGap(err)) return false;
      const r = await this.runBash(
        `if [ -e ${this.escapeSingle(p)} ] || [ -L ${this.escapeSingle(p)} ]; then exit 0; else exit 1; fi`,
      );
      return r.code === 0;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    const p = hostNormalize("wsl", dirPath);
    if (p === "/" || p === ".") return;
    try {
      const unc = await this.toUnc(p);
      await fsp.mkdir(unc, { recursive: true });
      return;
    } catch (err) {
      // \\wsl$\ recursive mkdir often fails for nested trees / 9P quirks —
      // same gap writeFile already handles via bash.
      if (!this.isUncGap(err)) {
        // Still try bash: some EACCES / EINVAL on UNC work fine inside Linux.
      }
    }
    const r = await this.runBash(`mkdir -p ${this.escapeSingle(p)}`);
    if (r.code !== 0) {
      throw new HostError(
        "failed",
        `Cannot create directory: ${p}`,
        r.stderr || r.stdout,
      );
    }
  }

  async openPty(
    cwd: string,
    cols: number,
    rows: number,
    opts?: { command?: string; args?: string[]; env?: Record<string, string> },
  ): Promise<PtyHandle> {
    if (process.platform !== "win32") {
      throw new HostError(
        "failed",
        "WSL host is only available on Windows",
      );
    }
    const wsl = this.resolveWslExe();
    const safeCwd = hostNormalize("wsl", cwd || this.workspaceRoot || "~");
    const args = [
      ...this.wslBaseArgs(),
      "--cd",
      safeCwd,
    ];
    if (opts?.command) {
      // Agent CLIs installed through nvm/npm are commonly added by ~/.bashrc.
      // Interactive login mode loads both login and interactive PATH setup.
      args.push(...buildWslAgentShellArgs(opts.command, opts.args ?? [], opts.env));
    } else if (opts?.env && Object.keys(opts.env).length) {
      // Rare: default shell with env exports.
      args.push(
        "--",
        "bash",
        "-lc",
        `${posixExportEnv(opts.env)}; exec bash -l`,
      );
    }
    // Prefer a clean env for wsl.exe: Windows process.env often injects empty
    // or wrong API keys that shadow the Linux login environment.
    const { handle } = await spawnLocalPty(
      process.env.USERPROFILE || "C:\\",
      cols,
      rows,
      {
        shell: wsl,
        args,
        env: {
          SystemRoot: process.env.SystemRoot || "C:\\Windows",
          PATH: process.env.PATH || "",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          WSLENV: process.env.WSLENV || "",
        },
      },
    );
    this.openPtys.add(handle);
    const origKill = handle.kill.bind(handle);
    handle.kill = () => {
      this.openPtys.delete(handle);
      origKill();
    };
    return handle;
  }

  async dispose(): Promise<void> {
    for (const p of [...this.openPtys]) {
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
    this.openPtys.clear();
    this.workspaceRoot = null;
  }
}

/** Quote argv for `bash -lc` so prompts with spaces stay one argument. */
export function posixShellCommand(command: string, args: string[]): string {
  const parts = [command, ...args].map((p) => {
    if (p === "") return "''";
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(p)) return p;
    return `'${p.replace(/'/g, `'\\''`)}'`;
  });
  return parts.join(" ");
}

/** `export KEY='val'; ...` for bash -lc; empty if no env. */
export function posixExportEnv(env?: Record<string, string>): string {
  if (!env) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (typeof v !== "string") continue;
    parts.push(`export ${k}=${shellSingleQuote(v)}`);
  }
  return parts.join("; ");
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function spawnCapture(
  command: string,
  args: string[],
  timeoutMs = 0,
  stdin?: string,
  earlyExit?: (stdout: string, stderr: string) => boolean,
  onStdoutChunk?: (chunk: string, stdout: string) => void,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let early = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        earlyExit: early || undefined,
      });
    };

    const requestEarlyExit = () => {
      if (settled || early) return;
      early = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(0);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(
          new HostError(
            "timeout",
            `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.slice(0, 4).join(" ")}…`,
          ),
        );
      }, timeoutMs);
    }

    if (stdin !== undefined) {
      child.stdin?.on("error", () => {
        // ignore — EPIPE if child exits before reading stdin
      });
      child.stdin?.end(stdin);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString("utf8");
      stdout += text;
      try {
        onStdoutChunk?.(text, stdout);
      } catch {
        // ignore
      }
      if (earlyExit?.(stdout, stderr)) {
        requestEarlyExit();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new HostError("failed", `Failed to run ${command}`, err.message),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      finish(code ?? 1);
    });
  });
}

/** List installed WSL distros (Windows only). */
export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const wsl = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\wsl.exe`
    : "wsl.exe";
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(wsl, ["-l", "-q"], {
        shell: false,
        windowsHide: true,
        env: process.env,
      });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code !== 0) {
          resolve("");
          return;
        }
        const buf = Buffer.concat(chunks);
        // wsl.exe -l emits UTF-16LE on Windows.
        let decoded = buf.toString("utf16le").replace(/^\uFEFF/, "");
        if (!decoded.trim() || decoded.includes("\uFFFD")) {
          decoded = buf.toString("utf8");
        }
        resolve(decoded.replace(/\u0000/g, ""));
      });
    });
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^windows subsystem/i.test(s));
  } catch {
    return [];
  }
}
