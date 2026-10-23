import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { HostSession } from "../host/types.js";

export interface FileWatchOptions {
  /** Only directories hidden from the tree may be pruned; search settings decide whether to prune them. */
  ignoredDirNames?: string[];
}

type PendingChange = { rel: string; path: string; eventType: "rename" | "change" };
type FileChange = PendingChange & { kind?: "file" | "dir" | "missing" | "unknown" };
const HIDDEN_TREE_DIRS = new Set([".git", "node_modules"]);
const STAT_CONCURRENCY = 6;

/** Local file-tree and annotation notifications; remote hosts use renderer polling. */
export class FileWatcherService {
  private watcher: FSWatcher | null = null;
  private root: string | null = null;
  /** Group paths once, instead of rescanning every pending path for every directory. */
  private pending = new Map<string, Map<string, PendingChange>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private flushingGeneration: number | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getHost: () => HostSession,
  ) {}

  private send(payload: unknown) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("fileWatcher:change", payload);
  }

  start(root: string, options: FileWatchOptions = {}): void {
    this.stop();
    const host = this.getHost();
    const lower = root.toLowerCase();
    if (
      host.kind !== "local" || lower.startsWith("\\\\wsl$\\") ||
      lower.startsWith("\\\\wsl.localhost\\") || lower.startsWith("//wsl$/") ||
      lower.startsWith("//wsl.localhost/")
    ) return;

    this.root = root;
    const generation = this.generation;
    const ignoredDirs = new Set((options.ignoredDirNames ?? []).filter((name) => HIDDEN_TREE_DIRS.has(name)));
    try {
      this.watcher = watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename || this.generation !== generation) return;
        const rel = filename.replace(/\\/g, "/");
        // Keep the directory's own event, so creating/deleting its tree node is visible.
        if (rel.split("/").slice(0, -1).some((part) => ignoredDirs.has(part))) return;
        const absolute = path.join(root, filename);
        const dir = path.dirname(absolute);
        let changes = this.pending.get(dir);
        if (!changes) this.pending.set(dir, changes = new Map());
        const previous = changes.get(rel);
        changes.set(rel, {
          rel,
          path: absolute,
          // A subsequent write must not erase an earlier create/remove notification.
          eventType: eventType === "rename" || previous?.eventType === "rename" ? "rename" : "change",
        });
        this.schedule(root, host, generation);
      });
      this.watcher.on("error", (err) => {
        console.warn("[fileWatcher] watcher error:", err);
        if (this.generation !== generation) return;
        this.watcher?.close();
        this.watcher = null;
        setTimeout(() => {
          if (this.generation === generation) this.start(root, options);
        }, 1000);
      });
    } catch (err) {
      console.warn("[fileWatcher] fs.watch failed:", err);
      this.watcher = null;
    }
  }

  private schedule(root: string, host: HostSession, generation: number): void {
    if (this.timer || this.generation !== generation) return;
    // Flush at most once per interval, even during a continuous build/write burst.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush(root, host, generation);
    }, 300);
  }

  private async flush(root: string, host: HostSession, generation: number): Promise<void> {
    if (this.generation !== generation || this.flushingGeneration === generation) return;
    this.flushingGeneration = generation;
    const batch = this.pending;
    this.pending = new Map();
    const byDirectory = [...batch].map(([dir, changes]) => ({
      dir,
      changes: [...changes.values()].map((change): FileChange => ({ ...change })),
    }));
    const renamed = byDirectory.flatMap(({ changes }) => changes.filter((change) => change.eventType === "rename"));
    let next = 0;
    const worker = async () => {
      while (next < renamed.length && this.generation === generation) {
        const change = renamed[next++]!;
        try {
          const stat = await host.stat(change.path);
          change.kind = stat.isFile ? "file" : stat.isDir ? "dir" : "unknown";
        } catch (err) {
          const code = (err as { code?: string })?.code;
          change.kind = code === "not_found" || code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, renamed.length) }, worker));
      if (this.generation !== generation || this.root !== root) return;
      for (const payload of byDirectory) {
        this.send({ root, hostProfileId: host.profileId, ...payload });
      }
    } finally {
      if (this.flushingGeneration === generation) this.flushingGeneration = null;
      if (this.generation === generation && this.pending.size) this.schedule(root, host, generation);
    }
  }

  stop(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.watcher?.close();
    this.watcher = null;
    this.root = null;
  }

  disposeAll(): void { this.stop(); }
}
