import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchHitBatcher } from "./searchBatcher.js";

describe("createSearchHitBatcher", () => {
  afterEach(() => vi.useRealTimers());

  it("sends the first batch immediately, then coalesces by time", () => {
    vi.useFakeTimers();
    const sent: number[][] = [];
    const b = createSearchHitBatcher<number>((x) => sent.push(x), { intervalMs: 30 });
    b.push([1]);
    expect(sent).toEqual([[1]]);
    b.push([2]);
    b.push([3]);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(30);
    expect(sent).toEqual([[1], [2, 3]]);
  });

  it("flushes early when maxBatch is reached and on explicit flush", () => {
    vi.useFakeTimers();
    const sent: number[][] = [];
    const b = createSearchHitBatcher<number>((x) => sent.push(x), { maxBatch: 3 });
    b.push([0]);
    b.push([1, 2, 3]);
    expect(sent).toEqual([[0], [1, 2, 3]]);
    b.push([4]);
    b.flush();
    expect(sent.at(-1)).toEqual([4]);
    b.push([5]);
    b.dispose();
    vi.advanceTimersByTime(100);
    expect(sent.flat()).not.toContain(5);
  });
});
