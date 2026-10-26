import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  DirEntry,
  HostSession,
  PtyHandle,
  ReadFileOptions,
  RunOptions,
  RunResult,
  StatResult,
} from "./types.js";
import { HostError } from "./types.js";
import {
  binaryReadLimit,
  boundedReadCommand,
  decodeBoundedBase64,
  decodeFilePrefix,
  fileReadLimit,
  readLocalFile,
  readLocalFileBytes,
} from "./fileRead.js";
import { hostNormalize } from "./paths.js";
import { spawnLocalPty } from "./localPty.js";
import {
  WslSearchHelperClient,
  buildWslExecArgs,
  buildWslGroupExecArgs,
  buildWslInstallScript,
  buildWslKillGroupArgs,
  parseWslInstallOutput,
  takePgidMarker,
  type WslSearchTools,
} from "./wslSearchTools.js";

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
  const scriptPath = `/tmp/anchor-agent-${randomUUID()}.sh`;
  const exports = posixExportEnv(env);
  const commandLine = posixShellCommand(command, args);
  const script = [
    exports,
    `rm -f ${shellSingleQuote(scriptPath)}`,
    `exec ${commandLine}`,
  ].filter(Boolean).join("; ");
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const bootstrap = `printf '%s' '${encoded}' | base64 -d > ${shellSingleQuote(scriptPath)}; exec bash ${shellSingleQuote(scriptPath)}`;
  // wsl.exe applies an extra parse to bash -c text and consumes `$...` syntax.
  // Decode the final argv script into WSL first, then execute it with the PTY.
  return ["--", "bash", "-lic", bootstrap];
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
      opts?.signal,
    );
  }

  private searchToolsPromise: Promise<WslSearchTools> | null = null;
  private helper: WslSearchHelperClient | null = null;
  private helperFailed = false;

  /**
   * Install rg + runner/helper scripts under ~/.cache/anchor once per session
   * (replaces the old per-search `chmod +x /mnt/c/…/rg`).
   * A failed install is not cached so a later search can retry.
   */
  ensureSearchTools(bundledRg: string | null): Promise<WslSearchTools> {
    if (!this.searchToolsPromise) {
      this.searchToolsPromise = (async () => {
        const r = await this.run("/", "bash", ["-s"], {
          stdin: buildWslInstallScript(bundledRg),
          timeoutMs: 30_000,
        });
        return parseWslInstallOutput(r.stdout);
      })();
      this.searchToolsPromise.catch(() => {
        this.searchToolsPromise = null;
      });
    }
    return this.searchToolsPromise;
  }

  /**
   * Run a search command with no login shell. Uses the persistent helper when
   * available (zero wsl.exe spawns per search), else `wsl.exe --exec setsid`
   * with process-group kill on cancel / early exit / timeout.
   */
  async runSearch(
    cwd: string,
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<RunResult> {
    const tools = await this.ensureSearchTools(null).catch(() => null);
    const safeCwd = hostNormalize("wsl", cwd || "/");
    const helper = tools ? await this.getHelper(tools) : null;
    if (helper) {
      try {
        return await helper.run(safeCwd, command, args, opts);
      } catch (err) {
        if (err instanceof HostError && err.code === "timeout") throw err;
        // Helper died mid-run — fall through to the spawn path.
      }
    }
    const base = this.wslBaseArgs();
    const wsl = this.resolveWslExe();
    const argv = tools
      ? buildWslGroupExecArgs(base, safeCwd, tools.runner, command, args)
      : buildWslExecArgs(base, safeCwd, command, args);
    let pgid: number | null = null;
    const killGroup = () => {
      if (pgid == null) return;
      try {
        spawn(wsl, buildWslKillGroupArgs(base, pgid), {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => {});
      } catch {
        // ignore
      }
    };
    const r = await spawnCapture(
      wsl,
      argv,
      opts?.timeoutMs ?? 45_000,
      opts?.stdin,
      opts?.earlyExit,
      opts?.onStdoutChunk,
      opts?.signal,
      (stderr) => {
        if (pgid == null) pgid = takePgidMarker(stderr).pgid;
      },
      killGroup,
    ).catch((err) => {
      killGroup();
      throw err;
    });
    const { rest } = takePgidMarker(r.stderr);
    return { ...r, stderr: rest };
  }

  private async getHelper(tools: WslSearchTools): Promise<WslSearchHelperClient | null> {
    if (this.helperFailed || !tools.helper || !tools.python) return null;
    if (this.helper?.alive) return this.helper;
    try {
      const child = spawn(
        this.resolveWslExe(),
        buildWslExecArgs(this.wslBaseArgs(), "/", tools.python, ["-u", tools.helper]),
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
      );
      const client = new WslSearchHelperClient(child);
      const ok = await Promise.race([
        client.ready.then(() => true),
        new Promise<boolean>((res) => setTimeout(() => res(false), 8_000)),
      ]);
      if (!ok || !client.alive) {
        client.dispose();
        this.helperFailed = true;
        return null;
      }
      this.helper = client;
      return client;
    } catch {
      this.helperFailed = true;
      return null;
    }
  }

  /** Stop the persistent helper (workspace switch / app quit). */
  disposeSearchHelper(): void {
    this.helper?.dispose();
    this.helper = null;
  }

  async readFile(filePath: string, options?: ReadFileOptions): Promise<string> {
    const p = hostNormalize("wsl", filePath);
    const limit = fileReadLimit(options);
    try {
      const unc = await this.toUnc(p);
      return await readLocalFile(unc, options);
    } catch (err) {
      if (!this.isUncGap(err)) {
        throw this.mapFsError(err, `Cannot read file: ${p}`);
      }
      // Absolute Linux symlinks are invisible/broken through \\wsl$\ — use cat.
      const command = limit === undefined
        ? `cat -- ${this.escapeSingle(p)}`
        : boundedReadCommand(this.escapeSingle(p), limit);
      const r = await this.runBash(
        `if [ ! -e ${this.escapeSingle(p)} ] && [ ! -L ${this.escapeSingle(p)} ]; then echo '__AC_ENOENT__' >&2; exit 44; fi; ${command}`,
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
      return limit === undefined ? r.stdout : decodeFilePrefix(Buffer.from(r.stdout, "base64"), limit);
    }
  }

  async readFileBytes(filePath: string, maxBytes?: number): Promise<Buffer> {
    const p = hostNormalize("wsl", filePath);
    const limit = binaryReadLimit(maxBytes);
    try {
      const unc = await this.toUnc(p);
      return await readLocalFileBytes(unc, limit);
    } catch (err) {
      if (!this.isUncGap(err)) {
        throw this.mapFsError(err, `Cannot read file: ${p}`);
      }
      // Same UNC symlink gap as readFile: stream base64 from the distro.
      const quoted = this.escapeSingle(p);
      const r = await this.runBash(
        `if [ ! -e ${quoted} ] && [ ! -L ${quoted} ]; then echo '__AC_ENOENT__' >&2; exit 44; fi; ${boundedReadCommand(quoted, limit)}`,
      );
      if (r.code === 44 || /__AC_ENOENT__/.test(r.stderr)) {
        throw new HostError("not_found", `Cannot read file: ${p}`, r.stderr);
      }
      if (r.code !== 0) {
        throw new HostError("failed", `Cannot read file: ${p}`, r.stderr || r.stdout);
      }
      return decodeBoundedBase64(r.stdout, limit, p);
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

  async remove(targetPath: string): Promise<void> {
    const p = hostNormalize("wsl", targetPath);
    const script = `rm -rf ${this.escapeSingle(p)}\n`;
    const r = await this.run(
      p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : "/",
      "bash",
      ["-s"],
      { stdin: script },
    );
    if (r.code !== 0) {
      throw new HostError("failed", `Cannot delete: ${p}`, r.stderr || r.stdout);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const src = hostNormalize("wsl", oldPath);
    const dst = hostNormalize("wsl", newPath);
    const script = `mv ${this.escapeSingle(src)} ${this.escapeSingle(dst)}\n`;
    const r = await this.run(
      src.includes("/") ? src.slice(0, src.lastIndexOf("/")) || "/" : "/",
      "bash",
      ["-s"],
      { stdin: script },
    );
    if (r.code !== 0) {
      throw new HostError(
        "failed",
        `Cannot rename: ${src} → ${dst}`,
        r.stderr || r.stdout,
      );
    }
  }

  async copyPath(srcPath: string, dstPath: string): Promise<void> {
    const src = hostNormalize("wsl", srcPath);
    const dst = hostNormalize("wsl", dstPath);
    const script = `cp -r ${this.escapeSingle(src)} ${this.escapeSingle(dst)}\n`;
    const r = await this.run(
      src.includes("/") ? src.slice(0, src.lastIndexOf("/")) || "/" : "/",
      "bash",
      ["-s"],
      { stdin: script },
    );
    if (r.code !== 0) {
      throw new HostError(
        "failed",
        `Cannot copy: ${src} → ${dst}`,
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
  signal?: AbortSignal,
  /** Sees cumulative stderr after each chunk (e.g. PGID marker). */
  onStderr?: (stderr: string) => void,
  /** Extra teardown when the run is cut short (abort / early exit / timeout). */
  onKill?: () => void,
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
    let aborted = false;
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        code,
        earlyExit: early || undefined,
        aborted: aborted || undefined,
      });
    };

    const killAll = () => {
      try {
        onKill?.();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
    };

    const requestEarlyExit = () => {
      if (settled || early) return;
      early = true;
      killAll();
      finish(0);
    };

    function onAbort() {
      if (settled) return;
      aborted = true;
      killAll();
      finish(0);
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        killAll();
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
      const text = outDec.write(chunk);
      if (!text) return;
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
      stderr += errDec.write(chunk);
      try {
        onStderr?.(stderr);
      } catch {
        // ignore
      }
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
      stdout += outDec.end();
      stderr += errDec.end();
      finish(code ?? 1);
    });
  });
}

/** WSL only accepts these characters in distro names. */
const WSL_DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Decode `wsl.exe -l -q` stdout into distro names.
 *
 * wsl.exe normally writes UTF-16LE (often with a BOM), but emits UTF-8 when
 * `WSL_UTF8=1` is set. Decoding UTF-8 as UTF-16LE turns ASCII pairs into CJK
 * garbage instead of U+FFFD, so pick the encoding from the bytes (BOM, then
 * NUL-byte pattern) rather than by trial. Lines that are not valid distro
 * names (localized "no distributions"/"not installed" messages) are dropped.
 */
export function decodeWslDistroList(buf: Buffer): string[] {
  let text: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2, buf.length - ((buf.length - 2) % 2)).toString("utf16le");
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString("utf8");
  } else {
    let oddNuls = 0;
    let evenNuls = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) continue;
      if (i % 2 === 1) oddNuls++;
      else evenNuls++;
    }
    const pairs = Math.floor(buf.length / 2);
    const utf16 = pairs > 0 && oddNuls >= pairs / 2 && oddNuls > evenNuls;
    text = utf16
      ? buf.subarray(0, pairs * 2).toString("utf16le")
      : buf.toString("utf8");
  }
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => WSL_DISTRO_NAME.test(s));
}

/** List installed WSL distros (Windows only). */
export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const wsl = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\wsl.exe`
    : "wsl.exe";
  try {
    return await new Promise<string[]>((resolve, reject) => {
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
        // Non-zero: WSL missing/disabled or no distros installed.
        resolve(code === 0 ? decodeWslDistroList(Buffer.concat(chunks)) : []);
      });
    });
  } catch {
    return [];
  }
}
