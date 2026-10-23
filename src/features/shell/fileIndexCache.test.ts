import { afterEach, describe, expect, it, vi } from "vitest";
import { FileIndexCache, type FileIndexRequest, type FileIndexResult } from "./fileIndexCache";

const request: FileIndexRequest = { root: "/repo", hostKind: "local", hostProfileId: "local-default", respectIgnore: true };
const result: FileIndexResult = { root: "/repo", files: ["src/a.ts", "src/nested/b.ts", "src-other/c.ts"], truncated: false };
function deferred() {
  let resolve!: (value: FileIndexResult) => void;
  const promise = new Promise<FileIndexResult>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("Quick Open file-index cache", () => {
  it("shares first-open work with an unfinished warm-up, including empty indexes", async () => {
    const cache = new FileIndexCache();
    const work = deferred();
    const fetch = vi.fn(() => work.promise);
    const warm = cache.load(request, fetch);
    const opened = cache.load(request, fetch);
    expect(opened).toBe(warm);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    work.resolve({ ...result, files: [] });
    await warm;
    expect((await cache.load(request, fetch)).files).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing remote index available while revalidation is pending", async () => {
    vi.useFakeTimers();
    const cache = new FileIndexCache();
    const remote = { ...request, hostKind: "ssh", hostProfileId: "server-a" };
    await cache.load(remote, async () => result);
    vi.advanceTimersByTime(5_001);
    const work = deferred();
    const refreshing = cache.load(remote, () => work.promise);
    expect(cache.peek(remote)?.files).toEqual(result.files);
    work.resolve({ ...result, files: ["fresh.ts"] });
    await refreshing;
    expect(cache.peek(remote)?.files).toEqual(["fresh.ts"]);
  });

  it("never shares same-root indexes across hosts or exclude settings", async () => {
    const cache = new FileIndexCache();
    await cache.load(request, async () => result);
    expect(cache.peek({ ...request, hostProfileId: "other" })).toBeUndefined();
    expect(cache.peek({ ...request, hostKind: "ssh" })).toBeUndefined();
    expect(cache.peek({ ...request, respectIgnore: false })).toBeUndefined();
    expect(cache.peek({ ...request, defaultExcludes: ["dist"] })).toBeUndefined();
  });

  it("does not let a late invalidated request replace newer index contents", async () => {
    const cache = new FileIndexCache();
    const old = deferred();
    const oldRequest = cache.load(request, () => old.promise);
    cache.invalidate(request.root);
    await cache.load(request, async () => ({ ...result, files: ["new.ts"] }));
    old.resolve(result);
    await oldRequest;
    expect(cache.peek(request)?.files).toEqual(["new.ts"]);
  });

  it("removes a deleted directory's descendants without dropping similarly named siblings", async () => {
    const cache = new FileIndexCache();
    await cache.load(request, async () => result);
    cache.remove(request, ["src"]);
    expect(cache.peek(request)?.files).toEqual(["src-other/c.ts"]);
  });

  it.each([false, true])("replays deletions onto an unfinished index (existing cache: %s)", async (warmed) => {
    vi.useFakeTimers();
    const cache = new FileIndexCache();
    if (warmed) {
      await cache.load(request, async () => result);
      vi.advanceTimersByTime(5 * 60_000 + 1);
    }
    const work = deferred();
    const loading = cache.load(request, () => work.promise);
    cache.remove(request, ["src"]);
    work.resolve(result);
    expect((await loading).files).toEqual(["src-other/c.ts"]);
    expect(cache.peek(request)?.files).toEqual(["src-other/c.ts"]);
  });
});
