import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
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
import { shellDisplayName, spawnLocalPty } from "./localPty.js";

function mapFsError(err: unknown, fallback: string): HostError {
  if (err instanceof HostError) return err;
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") {
    return new HostError("not_found", fallback, e.message);
  }
  if (e?.code === "EACCES" || e?.code === "EPERM") {
    return new HostError("permission", fallback, e.message);
  }
  return new HostError(
    "failed",
    fallback,
    e?.message ?? String(err),
  );
}

/**
 * Local HostSession — same-machine fs / spawn / node-pty.
 */
export class LocalHostSession implements HostSession {
  readonly id: string;
  readonly kind = "local" as const;
  readonly profileId: string;
  workspaceRoot: string | null = null;
  private openPtys = new Set<PtyHandle>();

  constructor(id?: string, profileId = "local-default") {
    this.id = id ?? `local-${randomUUID().slice(0, 8)}`;
    this.profileId = profileId;
  }

  async run(
    cwd: string,
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<RunResult> {
    const timeoutMs = opts?.timeoutMs ?? 45_000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        env: process.env,
        windowsHide: true,
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
        // Resolve immediately so callers do not wait for slow process teardown.
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
              `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`,
            ),
          );
        }, timeoutMs);
      }
      if (opts?.stdin !== undefined) {
        child.stdin?.on("error", () => {
          // ignore — EPIPE if child exits before reading stdin
        });
        child.stdin?.end(opts.stdin);
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout += chunk.toString("utf8");
        if (opts?.earlyExit?.(stdout, stderr)) {
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
          new HostError(
            "failed",
            `Failed to run ${command}`,
            err.message,
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) return;
        finish(code ?? 1);
      });
    });
  }

  async readFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      throw mapFsError(err, `Cannot read file: ${filePath}`);
    }
  }

  async writeFile(filePath: string, data: string): Promise<void> {
    try {
      await fs.writeFile(filePath, data, "utf8");
    } catch (err) {
      throw mapFsError(err, `Cannot write file: ${filePath}`);
    }
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    try {
      const names = await fs.readdir(dirPath, { withFileTypes: true });
      const entries: DirEntry[] = [];
      for (const d of names) {
        let type: "file" | "dir" = "file";
        if (d.isDirectory()) {
          type = "dir";
        } else if (d.isSymbolicLink()) {
          try {
            const st = await fs.stat(path.join(dirPath, d.name));
            type = st.isDirectory() ? "dir" : "file";
          } catch {
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
      throw mapFsError(err, `Cannot list directory: ${dirPath}`);
    }
  }

  async stat(filePath: string): Promise<StatResult> {
    try {
      const st = await fs.stat(filePath);
      return {
        isFile: st.isFile(),
        isDir: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch (err) {
      throw mapFsError(err, `Cannot stat: ${filePath}`);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (err) {
      throw mapFsError(err, `Cannot create directory: ${dirPath}`);
    }
  }

  async openPty(
    cwd: string,
    cols: number,
    rows: number,
    opts?: { command?: string; args?: string[]; env?: Record<string, string> },
  ): Promise<PtyHandle> {
    const spawnOpts = opts?.command
      ? {
          shell: opts.command,
          args: opts.args ?? [],
          env: opts.env
            ? { ...process.env, ...opts.env } as Record<string, string>
            : undefined,
        }
      : opts?.env
        ? { env: { ...process.env, ...opts.env } as Record<string, string> }
        : undefined;
    const { handle } = await spawnLocalPty(cwd, cols, rows, spawnOpts);
    this.openPtys.add(handle);
    const origKill = handle.kill.bind(handle);
    handle.kill = () => {
      this.openPtys.delete(handle);
      origKill();
    };
    return handle;
  }

  /** Shell basename for tab titles (best-effort). */
  static shellLabel(): string {
    if (process.platform === "win32") {
      return "cmd";
    }
    return shellDisplayName(process.env.SHELL || "zsh");
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
