import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { HostError, type HostSession, type StatResult } from "../host/types.js";
import { FileWatcherService } from "./fileWatcherService.js";

const watchers = vi.hoisted(() => [] as Array<{
  changed: (type: string, path: string) => void;
  error?: (error: Error) => void;
  close: ReturnType<typeof vi.fn>;
}>);

vi.mock("node:fs", () => ({
  watch: vi.fn((_root, _options, changed) => {
    const watcher = { changed, error: undefined as ((error: Error) => void) | undefined, close: vi.fn() };
    watchers.push(watcher);
    return { close: watcher.close, on: (_event: string, listener: (error: Error) => void) => { watcher.error = listener; } };
  }),
}));

const file: StatResult = { isFile: true, isDir: false, size: 1, mtimeMs: 1 };
let host: HostSession;
let send: ReturnType<typeof vi.fn>;
let service: FileWatcherService;

beforeEach(() => {
  vi.useFakeTimers();
  watchers.length = 0;
  host = { kind: "local", profileId: "local-default", stat: vi.fn(async () => file) } as unknown as HostSession;
  send = vi.fn();
  const window = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  service = new FileWatcherService(() => window, () => host);
});

afterEach(() => { service.stop(); vi.useRealTimers(); });

describe("local file watcher batches", () => {
  it("coalesces changes by directory, retains rename events, and bounds metadata reads", async () => {
    let active = 0;
    let maximum = 0;
    vi.mocked(host.stat).mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return file;
    });
    service.start("/repo");
    for (let i = 0; i < 24; i++) {
      const path = `dir${i % 3}/file${i}.ts`;
      watchers[0]!.changed("rename", path);
      watchers[0]!.changed("change", path);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(host.stat).toHaveBeenCalledTimes(24);
    expect(maximum).toBe(6);
    expect(send).toHaveBeenCalledTimes(3);
    const changes = send.mock.calls.flatMap((call) => call[1].changes);
    expect(changes).toHaveLength(24);
    expect(changes.every((change) => change.eventType === "rename" && change.kind === "file")).toBe(true);
    expect(send.mock.calls[0]![1]).toMatchObject({ root: "/repo", hostProfileId: "local-default" });
  });

  it("preserves annotation content events without any stat work", async () => {
    service.start("/repo");
    watchers[0]!.changed("change", ".anchor-code/session.yaml");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.stat).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("fileWatcher:change", expect.objectContaining({
      changes: [{ path: "/repo/.anchor-code/session.yaml", rel: ".anchor-code/session.yaml", eventType: "change" }],
    }));
  });

  it("prunes only opted-in hidden interiors, retaining visible generated paths and directory nodes", async () => {
    service.start("/repo", { ignoredDirNames: ["node_modules", ".git", "dist"] });
    for (const path of ["node_modules/lib/index.js", ".git/objects/ab/cd", "src/node_modules/pkg/file.js"]) {
      watchers[0]!.changed("rename", path);
    }
    watchers[0]!.changed("rename", ".git");
    watchers[0]!.changed("rename", "dist/output.js");
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.mocked(host.stat).mock.calls.map(([path]) => path)).toEqual(["/repo/.git", "/repo/dist/output.js"]);
    service.start("/repo", { ignoredDirNames: [] });
    watchers[1]!.changed("rename", "node_modules/lib/index.js");
    await vi.advanceTimersByTimeAsync(300);
    expect(host.stat).toHaveBeenLastCalledWith("/repo/node_modules/lib/index.js");
  });

  it("distinguishes directory creation, confirmed removal, and failed metadata reads", async () => {
    vi.mocked(host.stat).mockImplementation(async (path) => {
      if (path.endsWith("new-dir")) return { ...file, isFile: false, isDir: true };
      throw new HostError(path.endsWith("removed") ? "not_found" : "permission", "unavailable");
    });
    service.start("/repo");
    for (const path of ["new-dir", "removed", "forbidden"]) watchers[0]!.changed("rename", path);
    await vi.advanceTimersByTimeAsync(300);
    expect(send.mock.calls[0]![1].changes.map((change: { kind: string }) => change.kind)).toEqual(["dir", "missing", "unknown"]);
  });

  it("drops queued and in-flight events from a previous workspace or host", async () => {
    let finish!: (value: StatResult) => void;
    vi.mocked(host.stat).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    service.start("/repo");
    watchers[0]!.changed("rename", "old.ts");
    await vi.advanceTimersByTimeAsync(300);
    host = { kind: "local", profileId: "other-local", stat: vi.fn(async () => file) } as unknown as HostSession;
    service.start("/other");
    watchers[0]!.changed("rename", "late.ts");
    watchers[1]!.changed("rename", "current.ts");
    finish(file);
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ root: "/other", hostProfileId: "other-local" });
    expect(send.mock.calls[0]![1].changes[0].path).toBe("/other/current.ts");
  });

  it("does not let an old error retry restart a previous workspace", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    service.start("/first");
    watchers[0]!.error!(new Error("watch lost"));
    service.start("/second");
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchers).toHaveLength(2);
    vi.mocked(console.warn).mockRestore();
  });
});
