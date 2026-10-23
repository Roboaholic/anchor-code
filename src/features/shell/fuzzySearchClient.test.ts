import { describe, expect, it, vi } from "vitest";
import { rankFuzzyPaths } from "@/core/workspace/fuzzy";
import { FuzzySearchClient, type FuzzySearchRequest, type FuzzySearchResponse } from "./fuzzySearchClient";

class FakeWorker {
  onmessage: ((event: MessageEvent<FuzzySearchResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn<(request: FuzzySearchRequest) => void>();
  terminate = vi.fn();
  reply(value: FuzzySearchResponse) { this.onmessage?.({ data: value } as MessageEvent<FuzzySearchResponse>); }
}
const paths = Array.from({ length: 6000 }, (_, i) => `src/File${i}.ts`);

describe("Quick Open worker client", () => {
  it("sends a large index once, supersedes old queries, and ignores stale worker responses", async () => {
    const worker = new FakeWorker();
    const client = new FuzzySearchClient(() => worker as unknown as Worker);
    const first = client.search(paths, "file");
    const second = client.search(paths, "5999");
    expect(await first).toEqual([]);
    const [a, b] = worker.postMessage.mock.calls.map(([request]) => request);
    expect(a.paths).toBe(paths);
    expect(b.paths).toBeUndefined();
    worker.reply({ id: a.id, matches: rankFuzzyPaths(paths, "file", 80) });
    const expected = rankFuzzyPaths(paths, "5999", 80);
    worker.reply({ id: b.id, matches: expected });
    expect(await second).toEqual(expected);
    client.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back to cancellable batched ranking when worker creation is unavailable", async () => {
    const create = vi.fn((): Worker => { throw new Error("Worker unavailable"); });
    const client = new FuzzySearchClient(create);
    const obsolete = client.search(paths, "file");
    const current = client.search(paths, "5999");
    expect(await obsolete).toEqual([]);
    expect(await current).toEqual(rankFuzzyPaths(paths, "5999", 80));
    expect(create).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("recovers a failed worker's pending query and settles disposal", async () => {
    const worker = new FakeWorker();
    const client = new FuzzySearchClient(() => worker as unknown as Worker);
    const current = client.search(paths, "5999");
    worker.onmessageerror?.();
    expect(await current).toEqual(rankFuzzyPaths(paths, "5999", 80));
    const disposed = client.search(paths, "file");
    client.dispose();
    expect(await disposed).toEqual([]);
    expect(await client.search(paths, "new")).toEqual([]);
  });
});
