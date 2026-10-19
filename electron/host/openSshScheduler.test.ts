import { describe, expect, it, vi } from "vitest";
import { scheduleSshCommand } from "./openSshScheduler.js";

describe("native SSH command scheduler", () => {
  it("shares a two-command FIFO budget per alias and frees idle queues", () => {
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const fail = vi.fn();
    for (let i = 0; i < 5; i++) {
      scheduleSshCommand(i % 2 ? "work-queue" : "WORK-QUEUE", (release) => {
        started.push(i); releases.push(release);
      }, fail);
    }
    expect(started).toEqual([0, 1]);
    releases[0](); expect(started).toEqual([0, 1, 2]);
    releases[0](); expect(started).toEqual([0, 1, 2]);
    releases[1](); expect(started).toEqual([0, 1, 2, 3]);
    releases[2](); expect(started).toEqual([0, 1, 2, 3, 4]);
    releases[3](); releases[4]();
    // A later batch still has the full budget and no stale pending callbacks.
    scheduleSshCommand("work-queue", (release) => { started.push(5); release(); }, fail);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not block unrelated aliases", () => {
    const releases: (() => void)[] = [];
    const hold = (release: () => void) => releases.push(release);
    scheduleSshCommand("busy", hold, vi.fn());
    scheduleSshCommand("busy", hold, vi.fn());
    const unrelated = vi.fn((release: () => void) => release());
    scheduleSshCommand("unrelated", unrelated, vi.fn());
    expect(unrelated).toHaveBeenCalledOnce();
    releases.forEach((release) => release());
  });

  it("removes queued cancellations without releasing someone else's slot", () => {
    const releases: (() => void)[] = [];
    const hold = (release: () => void) => releases.push(release);
    const fail = vi.fn();
    const cancelRunning = scheduleSshCommand("cancel", hold, fail);
    scheduleSshCommand("cancel", hold, fail);
    const removed = vi.fn();
    const cancel = scheduleSshCommand("cancel", removed, fail);
    const next = vi.fn(hold);
    scheduleSshCommand("cancel", next, fail);
    cancel(); cancel(); cancelRunning();
    expect(next).not.toHaveBeenCalled();
    releases[0]();
    expect(removed).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    releases[1](); releases[2]();
  });

  it("returns slots after synchronous startup errors", () => {
    const failed = vi.fn();
    const error = new Error("spawn failed");
    const releases: (() => void)[] = [];
    scheduleSshCommand("failure", (release) => releases.push(release), failed);
    scheduleSshCommand("failure", () => { throw error; }, failed);
    scheduleSshCommand("failure", (release) => releases.push(release), failed);
    expect(releases).toHaveLength(2);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    releases.forEach((release) => release());
  });
});
