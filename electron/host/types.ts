/**
 * HostSession — execution-environment facade (PAL/HAL, not a business module).
 * Business modules call only through this surface; Renderer never touches PTY/SSH/child_process.
 */

export type HostKind = "local" | "wsl" | "ssh";

export type HostErrorCode =
  | "not_found"
  | "permission"
  | "disconnected"
  | "timeout"
  | "failed"
  | "not_git"
  | "not_implemented";

export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly causeDetail?: string;

  constructor(code: HostErrorCode, message: string, causeDetail?: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.causeDetail = causeDetail;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      cause: this.causeDetail,
    };
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when the process was stopped early via `earlyExit` (still a successful capture). */
  earlyExit?: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  stdin?: string;
  /**
   * Called after each stdout chunk with cumulative buffers.
   * Return true to kill the process and resolve successfully with current output
   * (used to stop content search once enough hits are collected).
   */
  earlyExit?: (stdout: string, stderr: string) => boolean;
  /**
   * Called for each stdout chunk as it arrives (before earlyExit).
   * Used to stream search hits to the UI without waiting for process exit.
   */
  onStdoutChunk?: (chunk: string, stdout: string) => void;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface StatResult {
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface PtyHandle {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  kill(): void;
}

/** Optional command for non-default shells (agent CLIs). */
export interface PtySpawnOptions {
  command?: string;
  args?: string[];
  /**
   * Extra env for the child process / login shell.
   * On WSL/SSH these are exported inside bash before `exec`.
   * Values must never include secrets from the app — only host-local paths/flags.
   */
  env?: Record<string, string>;
}

export interface HostSession {
  readonly id: string;
  readonly kind: HostKind;
  /** Active host profile id from settings (when known). */
  readonly profileId: string;
  workspaceRoot: string | null;

  run(
    cwd: string,
    command: string,
    args: string[],
    opts?: RunOptions,
  ): Promise<RunResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<StatResult>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
  openPty(
    cwd: string,
    cols: number,
    rows: number,
    opts?: PtySpawnOptions,
  ): Promise<PtyHandle>;
  dispose(): Promise<void>;
}
