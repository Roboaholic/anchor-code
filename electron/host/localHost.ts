import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DirEntry,
  HostSession,
  PtyHandle,
  RunResult,
  StatResult,
} from "./types.js";
import { HostError } from "./types.js";

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
 * Local HostSession — real fs (Slice 2); run/pty still deferred to later slices.
 */
export class LocalHostSession implements HostSession {
  readonly id: string;
  readonly kind = "local" as const;
  workspaceRoot: string | null = null;

  constructor(id?: string) {
    this.id = id ?? `local-${randomUUID().slice(0, 8)}`;
  }

  async run(
    cwd: string,
    command: string,
    args: string[],
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        reject(
          new HostError(
            "failed",
            `Failed to run ${command}`,
            err.message,
          ),
        );
      });
      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          code: code ?? 1,
        });
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
          // skip sockets, devices, etc.
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
    _cwd: string,
    _cols: number,
    _rows: number,
  ): Promise<PtyHandle> {
    throw new HostError(
      "not_implemented",
      "host.openPty is not implemented yet (terminal arrives in Slice 5)",
    );
  }

  async dispose(): Promise<void> {
    this.workspaceRoot = null;
  }
}
