import { randomUUID } from "node:crypto";
import type {
  DirEntry,
  HostSession,
  PtyHandle,
  RunResult,
  StatResult,
} from "./types.js";
import { HostError } from "./types.js";

/**
 * Local HostSession skeleton (Slice 1).
 * Full fs/run/pty land in later slices; openPty remains stub until terminal slice.
 */
export class LocalHostSession implements HostSession {
  readonly id: string;
  readonly kind = "local" as const;
  workspaceRoot: string | null = null;

  constructor(id?: string) {
    this.id = id ?? `local-${randomUUID().slice(0, 8)}`;
  }

  async run(
    _cwd: string,
    _command: string,
    _args: string[],
  ): Promise<RunResult> {
    throw new HostError(
      "not_implemented",
      "host.run is not implemented in Slice 1 (history/git arrives in Slice 3)",
    );
  }

  async readFile(_path: string): Promise<string> {
    throw new HostError(
      "not_implemented",
      "host.readFile is not implemented in Slice 1 (workspace arrives in Slice 2)",
    );
  }

  async writeFile(_path: string, _data: string): Promise<void> {
    throw new HostError(
      "not_implemented",
      "host.writeFile is not implemented in Slice 1",
    );
  }

  async listDir(_path: string): Promise<DirEntry[]> {
    throw new HostError(
      "not_implemented",
      "host.listDir is not implemented in Slice 1 (workspace arrives in Slice 2)",
    );
  }

  async stat(_path: string): Promise<StatResult> {
    throw new HostError(
      "not_implemented",
      "host.stat is not implemented in Slice 1",
    );
  }

  async exists(_path: string): Promise<boolean> {
    throw new HostError(
      "not_implemented",
      "host.exists is not implemented in Slice 1",
    );
  }

  async mkdirp(_path: string): Promise<void> {
    throw new HostError(
      "not_implemented",
      "host.mkdirp is not implemented in Slice 1",
    );
  }

  async openPty(
    _cwd: string,
    _cols: number,
    _rows: number,
  ): Promise<PtyHandle> {
    throw new HostError(
      "not_implemented",
      "host.openPty is not implemented in Slice 1 (terminal arrives in Slice 5)",
    );
  }

  async dispose(): Promise<void> {
    this.workspaceRoot = null;
  }
}
