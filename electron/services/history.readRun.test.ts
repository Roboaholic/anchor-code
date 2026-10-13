import { describe, expect, it, vi } from "vitest";
import { readRun } from "./historyService.js";

const ok = { stdout: "x", stderr: "", code: 0 };

describe("historyService.readRun", () => {
  it("uses runSearch on WSL", async () => {
    const host = { kind: "wsl", run: vi.fn(async () => ok), runSearch: vi.fn(async () => ok) };
    await readRun(host as never, "/r", "git", ["log"]);
    expect(host.runSearch).toHaveBeenCalledWith("/r", "git", ["log"], undefined);
    expect(host.run).not.toHaveBeenCalled();
  });
  it("falls back to host.run when helper throws or command missing", async () => {
    const host = {
      kind: "wsl",
      run: vi.fn(async () => ok),
      runSearch: vi.fn().mockRejectedValueOnce(new Error("dead")).mockResolvedValueOnce({ ...ok, code: 127 }),
    };
    await readRun(host as never, "/r", "git", []);
    await readRun(host as never, "/r", "git", []);
    expect(host.run).toHaveBeenCalledTimes(2);
  });
  it("uses host.run on local/ssh", async () => {
    const host = { kind: "local", run: vi.fn(async () => ok), runSearch: vi.fn() };
    await readRun(host as never, "/r", "git", []);
    expect(host.runSearch).not.toHaveBeenCalled();
  });
});
