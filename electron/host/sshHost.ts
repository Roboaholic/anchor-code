import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import type {
  DirEntry,
  HostSession,
  PtyHandle,
  RunResult,
  StatResult,
} from "./types.js";
import { HostError } from "./types.js";
import { hostNormalize } from "./paths.js";

export interface SshHostOptions {
  profileId: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  /** Inline private key (prefer path). */
  privateKey?: string;
  passphrase?: string;
  readyTimeoutMs?: number;
}

/**
 * Generic SSH HostSession (optional path for true remote; WSL prefers WslHostSession).
 */
export class SshHostSession implements HostSession {
  readonly id: string;
  readonly kind = "ssh" as const;
  readonly profileId: string;
  workspaceRoot: string | null = null;

  private readonly opts: SshHostOptions;
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private connecting: Promise<void> | null = null;
  private openPtys = new Set<PtyHandle>();

  constructor(opts: SshHostOptions) {
    this.id = `ssh-${randomUUID().slice(0, 8)}`;
    this.profileId = opts.profileId;
    this.opts = opts;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) {
      await this.connecting;
      if (!this.client) {
        throw new HostError("disconnected", "SSH connection failed");
      }
      return this.client;
    }
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    if (!this.client) {
      throw new HostError("disconnected", "SSH connection failed");
    }
    return this.client;
  }

  private async connect(): Promise<void> {
    const client = new Client();
    let privateKey = this.opts.privateKey;
    if (!privateKey && this.opts.privateKeyPath) {
      try {
        privateKey = await fs.readFile(this.opts.privateKeyPath, "utf8");
      } catch (err) {
        throw new HostError(
          "failed",
          `Cannot read SSH private key: ${this.opts.privateKeyPath}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end();
        reject(
          new HostError(
            "timeout",
            `SSH connect timeout to ${this.opts.host}:${this.opts.port ?? 22}`,
          ),
        );
      }, this.opts.readyTimeoutMs ?? 15_000);

      client
        .on("ready", () => {
          clearTimeout(timer);
          this.client = client;
          resolve();
        })
        .on("error", (err) => {
          clearTimeout(timer);
          this.client = null;
          this.sftp = null;
          reject(
            new HostError(
              "disconnected",
              `SSH error: ${err.message}`,
              err.message,
            ),
          );
        })
        .on("end", () => {
          this.client = null;
          this.sftp = null;
        })
        .on("close", () => {
          this.client = null;
          this.sftp = null;
        })
        .connect({
          host: this.opts.host,
          port: this.opts.port ?? 22,
          username: this.opts.username,
          privateKey,
          passphrase: this.opts.passphrase,
          readyTimeout: this.opts.readyTimeoutMs ?? 15_000,
          // agent if no key
          agent: privateKey ? undefined : process.env.SSH_AUTH_SOCK,
        });
    });
  }

  private async ensureSftp(): Promise<SFTPWrapper> {
    const client = await this.ensureConnected();
    if (this.sftp) return this.sftp;
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err || !sftp) {
          reject(
            new HostError(
              "failed",
              "Failed to open SFTP",
              err?.message,
            ),
          );
          return;
        }
        resolve(sftp);
      });
    });
    return this.sftp;
  }

  async run(
    cwd: string,
    command: string,
    args: string[],
    opts?: { timeoutMs?: number; stdin?: string },
  ): Promise<RunResult> {
    const client = await this.ensureConnected();
    const safeCwd = hostNormalize("ssh", cwd || "/");
    const quoted = [command, ...args]
      .map((a) => shellQuote(a))
      .join(" ");
    const remote = `cd ${shellQuote(safeCwd)} && ${quoted}`;
    const timeoutMs = opts?.timeoutMs ?? 45_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      let stream: ClientChannel | null = null;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              try {
                stream?.close();
              } catch {
                // ignore
              }
              reject(
                new HostError(
                  "timeout",
                  `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`,
                ),
              );
            }, timeoutMs)
          : undefined;
      client.exec(remote, (err, s) => {
        if (err || !s) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new HostError(
              "failed",
              `SSH exec failed: ${command}`,
              err?.message,
            ),
          );
          return;
        }
        stream = s;
        let stdout = "";
        let stderr = "";
        s.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        }).stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        s.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout,
            stderr,
            code: code ?? 1,
          });
        });
        s.on("error", (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new HostError("failed", `SSH stream error: ${e.message}`));
        });
        if (opts?.stdin !== undefined) {
          // Feed stdin then signal EOF so `bash -s` / `read` loops terminate.
          s.write(opts.stdin);
          try {
            s.end();
          } catch {
            // ignore — some shells close early
          }
        }
      });
    });
  }

  async readFile(filePath: string): Promise<string> {
    const sftp = await this.ensureSftp();
    const p = hostNormalize("ssh", filePath);
    return new Promise((resolve, reject) => {
      sftp.readFile(p, "utf8", (err, data) => {
        if (err) {
          reject(mapSftpError(err, `Cannot read file: ${p}`));
          return;
        }
        resolve(typeof data === "string" ? data : data.toString("utf8"));
      });
    });
  }

  async writeFile(filePath: string, data: string): Promise<void> {
    const sftp = await this.ensureSftp();
    const p = hostNormalize("ssh", filePath);
    await this.mkdirp(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) || "/" : "/");
    return new Promise((resolve, reject) => {
      sftp.writeFile(p, data, (err) => {
        if (err) {
          reject(mapSftpError(err, `Cannot write file: ${p}`));
          return;
        }
        resolve();
      });
    });
  }

  async listDir(dirPath: string): Promise<DirEntry[]> {
    const sftp = await this.ensureSftp();
    const p = hostNormalize("ssh", dirPath);
    return new Promise((resolve, reject) => {
      sftp.readdir(p, (err, list) => {
        if (err) {
          reject(mapSftpError(err, `Cannot list directory: ${p}`));
          return;
        }
        const entries: DirEntry[] = (list ?? [])
          .filter((e) => e.filename !== "." && e.filename !== "..")
          .map((e) => ({
            name: e.filename,
            type: (e.attrs.isDirectory?.() ? "dir" : "file") as "file" | "dir",
          }));
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
        resolve(entries);
      });
    });
  }

  async stat(filePath: string): Promise<StatResult> {
    const sftp = await this.ensureSftp();
    const p = hostNormalize("ssh", filePath);
    return new Promise((resolve, reject) => {
      sftp.stat(p, (err, st) => {
        if (err) {
          reject(mapSftpError(err, `Cannot stat: ${p}`));
          return;
        }
        resolve({
          isFile: st.isFile(),
          isDir: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtime * 1000,
        });
      });
    });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.stat(filePath);
      return true;
    } catch (err) {
      if (err instanceof HostError && err.code === "not_found") return false;
      return false;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    const sftp = await this.ensureSftp();
    const p = hostNormalize("ssh", dirPath);
    if (p === "/" || p === ".") return;
    const parts = p.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = `${cur}/${part}`;
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(cur, (err) => {
          if (!err) {
            resolve();
            return;
          }
          sftp.stat(cur, (statErr, st) => {
            if (!statErr && st?.isDirectory()) {
              resolve();
              return;
            }
            reject(mapSftpError(err, `Cannot create directory: ${cur}`));
          });
        });
      });
    }
  }

  async openPty(
    cwd: string,
    cols: number,
    rows: number,
    opts?: { command?: string; args?: string[]; env?: Record<string, string> },
  ): Promise<PtyHandle> {
    const client = await this.ensureConnected();
    const safeCwd = hostNormalize("ssh", cwd || this.workspaceRoot || "~");
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        {
          term: "xterm-256color",
          cols: Math.max(cols, 20),
          rows: Math.max(rows, 5),
        },
        (err, stream) => {
          if (err || !stream) {
            reject(
              new HostError(
                "failed",
                "Failed to open SSH shell",
                err?.message,
              ),
            );
            return;
          }
          resolve(stream);
        },
      );
    });

    // cd into workspace after shell starts, then optional agent CLI.
    if (safeCwd && safeCwd !== "~") {
      channel.write(`cd ${shellQuote(safeCwd)}\n`);
    }
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        channel.write(`export ${k}=${shellQuote(v)}\n`);
      }
    }
    if (opts?.command) {
      const parts = [opts.command, ...(opts.args ?? [])].map(shellQuote);
      channel.write(`${parts.join(" ")}\n`);
    }

    const id = `ssh-pty-${randomUUID().slice(0, 8)}`;
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number) => void>();
    let alive = true;

    channel.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const cb of dataListeners) cb(text);
    });
    channel.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const cb of dataListeners) cb(text);
    });
    channel.on("close", () => {
      alive = false;
      for (const cb of exitListeners) cb(0);
      this.openPtys.delete(handle);
    });

    const handle: PtyHandle = {
      id,
      write(data: string) {
        if (!alive) return;
        channel.write(data);
      },
      resize(c: number, r: number) {
        if (!alive) return;
        try {
          channel.setWindow(Math.max(r, 1), Math.max(c, 2), 0, 0);
        } catch {
          // ignore
        }
      },
      onData(cb) {
        dataListeners.add(cb);
      },
      onExit(cb) {
        exitListeners.add(cb);
      },
      kill() {
        if (!alive) return;
        alive = false;
        try {
          channel.close();
        } catch {
          // ignore
        }
      },
    };
    this.openPtys.add(handle);
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
    this.sftp = null;
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.workspaceRoot = null;
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function mapSftpError(err: Error & { code?: number | string }, message: string): HostError {
  const code = err.code;
  if (code === 2 || code === "ENOENT") {
    return new HostError("not_found", message, err.message);
  }
  if (code === 3 || code === "EACCES") {
    return new HostError("permission", message, err.message);
  }
  return new HostError("failed", message, err.message);
}
