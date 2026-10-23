import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoalescedWriter } from "./coalescedWriter.js";

afterEach(() => vi.useRealTimers());

describe("coalesced state writes", () => {
  it("flushes the latest queued snapshot without waiting for the debounce", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createCoalescedWriter(write);
    const first = writer.enqueue("a");
    const last = writer.enqueue("b");
    expect(write).not.toHaveBeenCalled();
    await writer.flush();
    await Promise.all([first, last]);
    expect(write.mock.calls).toEqual([["b"]]);
  });

  it("never lets an earlier in-flight write overwrite the final selection", async () => {
    let finishFirst!: () => void;
    let active = 0;
    let maximum = 0;
    const written: string[] = [];
    const writer = createCoalescedWriter<string>(async (value) => {
      maximum = Math.max(maximum, ++active);
      if (value === "a") await new Promise<void>((resolve) => { finishFirst = resolve; });
      written.push(value);
      active--;
    });
    const first = writer.enqueue("a");
    const flushing = writer.flush();
    await Promise.resolve();
    const second = writer.enqueue("b");
    const last = writer.enqueue("c");
    finishFirst();
    await Promise.all([first, second, last, flushing]);
    expect(written).toEqual(["a", "c"]);
    expect(maximum).toBe(1);
  });

  it("reports a failed write and can persist a later snapshot", async () => {
    const error = new Error("disk full");
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const writer = createCoalescedWriter(write);
    const rejected = expect(writer.enqueue("a")).rejects.toThrow("disk full");
    await expect(writer.flush()).rejects.toThrow("disk full");
    await rejected;
    const next = writer.enqueue("b");
    await writer.flush();
    await next;
    expect(write.mock.calls).toEqual([["a"], ["b"]]);
  });
});
