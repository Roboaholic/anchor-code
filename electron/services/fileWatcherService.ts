import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { HostSession } from "../host/types.js";

/**
 * File-tree auto-refresh for local workspaces.
 *
 * fs.watch(recursive) only works on real local paths. WSL UNC paths
 * (`\\wsl$\…`, `\\wsl.localhost\…`) throw EISDIR on watch, and SSH has no local
 * path at all — those hosts rely on renderer-side polling instead (see
 * FileTree.tsx). So this service only starts a watcher for local-drive roots.
 */
export class FileWatcherService {
  private getWindow: () => BrowserWindow | null;
  private getHost: () => HostSession;
  /** Current recursive watcher, if any. */
  private watcher: FSWatcher | null = null;
  /** Root currently being watched. */
  private root: string | null = null;
  /** Per-directory debounce timers so a burst of events coalesces into one dir change. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pending path deltas coalesced with the directory refresh. */
  private pendingDelta = new Map<string, { rel: string; abs: string; eventType: string }>();
  /** True after stop(); suppresses the self-rebuild after an error. */
  private disposed = false;

  constructor(
    getWindow: () => BrowserWindow | null,
    getHost: () => HostSession,
  ) {
    this.getWindow = getWindow;
    this.getHost = getHost;
  }

  private send(channel: string, payload: unknown) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  /** WSL UNC paths — fs.watch throws EISDIR on these (empirically verified). */
  private isUnc(root: string): boolean {
    const lower = root.toLowerCase();
    return (
      lower.startsWith("\\\\wsl$\\") ||
      lower.startsWith("\\\\wsl.localhost\\") ||
      lower.startsWith("//wsl$/") ||
      lower.startsWith("//wsl.localhost/")
    );
  }

  /**
   * Start watching `root` (recursive). No-op for UNC/SSH roots — the renderer
   * polls those. Stops any previous watcher first.
   */
  start(root: string): void {
    this.stop();
    this.disposed = false;

    const host = this.getHost();
    // SSH has no local path; WSL paths are UNC and throw on fs.watch.
    if (host.kind === "ssh" || this.isUnc(root)) {
      return;
    }

    this.root = root;
    try {
      this.watcher = watch(
        root,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;
          const abs = path.join(root, filename);
          const dir = path.dirname(abs);
          const rel = filename.replace(/\\/g, "/");
          this.schedule(dir, { rel, abs, eventType: eventType === "rename" ? "rename" : "change" });
        },
      );
    } catch (err) {
      console.warn("[fileWatcher] fs.watch failed:", err);
      this.watcher = null;
      return;
    }

    this.watcher.on("error", (err) => {
      console.warn("[fileWatcher] watcher error:", err);
      // Watchers can drop unexpectedly; rebuild once if not deliberately stopped.
      if (!this.disposed && this.root) {
        const root = this.root;
        try {
          this.watcher?.close();
        } catch {
          // ignore
        }
        this.watcher = null;
        setTimeout(() => {
          if (!this.disposed) this.start(root);
        }, 1000);
      }
    });
  }

  /** Debounce a directory change: coalesce burst events, then notify once. */
  private schedule(
    dir: string,
    delta?: { rel: string; abs: string; eventType: string },
  ): void {
    if (delta?.rel) this.pendingDelta.set(delta.rel, delta);
    const existing = this.pending.get(dir);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pending.delete(dir);
      const changes: { rel: string; abs: string; eventType: string }[] = [];
      for (const [rel, d] of [...this.pendingDelta.entries()]) {
        // Flush deltas under this directory (or any if single root watch).
        if (
          path.dirname(path.join(this.root ?? "", rel)) === dir ||
          path.normalize(path.dirname(d.abs)) === path.normalize(dir)
        ) {
          changes.push(d);
          this.pendingDelta.delete(rel);
        }
      }
      this.send("fileWatcher:change", {
        dir,
        changes: changes.map((c) => ({
          path: c.abs,
          rel: c.rel,
          eventType: c.eventType,
        })),
      });
    }, 300);
    this.pending.set(dir, t);
  }

  stop(): void {
    this.disposed = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.pendingDelta.clear();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
    this.root = null;
  }

  disposeAll(): void {
    this.stop();
  }
}
