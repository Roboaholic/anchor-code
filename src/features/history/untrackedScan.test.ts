import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNTRACKED_SCAN_TIMEOUT_MS, useHistoryStore } from "./historyStore";
import type { RepoStatus } from "@/shared/anchor-api";

const ROOTS = ["/ws/a", "/ws/b"];

function st(root: string, patch: Partial<RepoStatus> = {}): RepoStatus {
  return {
    repoRoot: root,
    entries: [],
    modified: 0,
    added: 0,
    deleted: 0,
    untracked: 0,
    branch: "dev",
    ahead: 0,
    behind: 0,
    ...patch,
  };
}
const untracked = (root: string, paths: string[]) =>
  st(root, {
    entries: paths.map((path) => ({ path, status: "?", code: "??" })),
    untracked: paths.length,
    untrackedScanned: true,
  });

/** Scan results the fake host returns for `scanUntracked: true`. */
let scanResult: (root: string) => RepoStatus;
let statusBulk: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scanResult = (root) => st(root, { untrackedScanned: true });
  statusBulk = vi.fn(async (args: { repoRoots: string[]; scanUntracked?: boolean }) =>
    args.repoRoots.map((r) => (args.scanUntracked ? scanResult(r) : st(r, { untrackedScanned: false }))),
  );
  (globalThis as { window?: unknown }).window = {
    anchor: {
      history: {
        discover: vi.fn(async () => ROOTS.map((root) => ({ root, name: root.slice(4) }))),
        statusBulk,
        status: vi.fn(async (root: string) => st(root, { untrackedScanned: true })),
        getRecentCompares: vi.fn(async () => []),
      },
    },
  };
  useHistoryStore.getState().reset();
});
afterEach(() => {
  vi.useRealTimers();
});

const card = (root: string) => useHistoryStore.getState().repos.find((r) => r.root === root)!;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("badge untracked scan", () => {
  it("runs once on workspace load, after the first tracked-only pass", async () => {
    await useHistoryStore.getState().discover("/ws");
    await vi.waitFor(() => expect(statusBulk).toHaveBeenCalledTimes(2));
    expect(statusBulk.mock.calls[0]![0]).toMatchObject({ badgeOnly: true });
    expect(statusBulk.mock.calls[0]![0].scanUntracked).toBeUndefined();
    expect(statusBulk.mock.calls[1]![0]).toMatchObject({ badgeOnly: true, scanUntracked: true, repoRoots: ROOTS });
  });

  it("keeps U through the 30s -uno poll and clears it when a scan finds none", async () => {
    await useHistoryStore.getState().discover("/ws");
    await vi.waitFor(() => expect(statusBulk).toHaveBeenCalledTimes(2));
    scanResult = (root) => (root === "/ws/a" ? untracked(root, ["notes.txt"]) : st(root, { untrackedScanned: true }));
    await useHistoryStore.getState().scanUntracked();
    expect(card("/ws/a").status).toMatchObject({ untracked: 1, untrackedScanned: true });

    // Tracked-only poll sees no untracked files: U and the scanned flag persist.
    await useHistoryStore.getState().softRefreshStatuses();
    expect(card("/ws/a").status).toMatchObject({ untracked: 1, untrackedScanned: true });
    expect(card("/ws/b").status).toMatchObject({ untracked: 0, untrackedScanned: true });

    // Next scan finds nothing: U clears.
    scanResult = (root) => st(root, { untrackedScanned: true });
    await useHistoryStore.getState().scanUntracked();
    expect(card("/ws/a").status).toMatchObject({ untracked: 0, entries: [] });
  });

  it("dedupes concurrent scans into one host command", async () => {
    await useHistoryStore.getState().discover("/ws");
    await vi.waitFor(() => expect(statusBulk).toHaveBeenCalledTimes(2));
    const p1 = useHistoryStore.getState().scanUntracked();
    const p2 = useHistoryStore.getState().scanUntracked();
    expect(p2).toBe(p1);
    await p1;
    expect(statusBulk).toHaveBeenCalledTimes(3);
  });

  it("times out quietly and keeps the last known U", async () => {
    await useHistoryStore.getState().discover("/ws");
    await vi.waitFor(() => expect(statusBulk).toHaveBeenCalledTimes(2));
    scanResult = (root) => untracked(root, ["n.txt"]);
    await useHistoryStore.getState().scanUntracked();

    vi.useFakeTimers();
    statusBulk.mockImplementationOnce(() => new Promise(() => {}));
    const pending = useHistoryStore.getState().scanUntracked();
    await vi.advanceTimersByTimeAsync(UNTRACKED_SCAN_TIMEOUT_MS + 1);
    await pending;
    expect(useHistoryStore.getState().toast).toBeNull();
    expect(card("/ws/a").status).toMatchObject({ untracked: 1 });
    // In-flight slot released: a later trigger runs again.
    const before = statusBulk.mock.calls.length;
    await useHistoryStore.getState().scanUntracked();
    await flush();
    expect(statusBulk.mock.calls.length).toBe(before + 1);
  });

  it("per-repo Refresh rescans that repo's untracked files immediately (full status)", async () => {
    await useHistoryStore.getState().discover("/ws");
    await vi.waitFor(() => expect(statusBulk).toHaveBeenCalledTimes(2));
    const status = (window as unknown as { anchor: { history: { status: ReturnType<typeof vi.fn> } } }).anchor.history.status;
    status.mockImplementationOnce(async (root: string) => untracked(root, ["fresh.txt"]));
    await useHistoryStore.getState().refreshRepo("/ws/a");
    expect(status).toHaveBeenCalledWith("/ws/a", { badgeOnly: false });
    expect(card("/ws/a").status).toMatchObject({ untracked: 1, untrackedScanned: true });
    expect(card("/ws/b").status).toMatchObject({ untracked: 0 });
  });
});
