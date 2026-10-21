import { describe, expect, it, vi } from "vitest";
import { loadRepoStatus, loadRepoStatusesBulk, untrackedFilesMode } from "./historyService.js";

describe("badge untracked scan", () => {
  it("maps modes: -uno poll, normal scan, all for expanded views", () => {
    expect(untrackedFilesMode(true, false)).toBe("no");
    expect(untrackedFilesMode(true, true)).toBe("normal");
    expect(untrackedFilesMode(false, false)).toBe("all");
    expect(untrackedFilesMode(false, true)).toBe("all");
  });

  it("SSH bulk: one bash -s with untracked='normal' and flags results as scanned", async () => {
    const stdout = [
      "__AC_BEGIN__\t/r/a",
      "## dev",
      "?? build/",
      "__AC_END__",
      "__AC_BEGIN__\t/r/b",
      "## dev",
      "__AC_END__",
      "",
    ].join("\n");
    const run = vi.fn(async (_cwd: string, _cmd: string, _args: string[], opts?: { stdin?: string; onStdoutChunk?: (c: string, s: string) => void }) => {
      opts?.onStdoutChunk?.(stdout, stdout);
      return { code: 0, stdout, stderr: "" };
    });
    const host = { kind: "ssh", run };
    const out = await loadRepoStatusesBulk(host as never, ["/r/a", "/r/b"], { badgeOnly: true, scanUntracked: true });
    expect(run).toHaveBeenCalledTimes(1);
    const [, cmd, args, opts] = run.mock.calls[0]!;
    expect([cmd, args]).toEqual(["bash", ["-s"]]);
    expect(opts?.stdin).toContain("untracked='normal'");
    expect(out.map((s) => [s.repoRoot, s.untracked, s.untrackedScanned])).toEqual([
      ["/r/a", 1, true],
      ["/r/b", 0, true],
    ]);
  });

  it("SSH bulk tracked-only poll keeps -uno and is not flagged as scanned", async () => {
    const stdout = "__AC_BEGIN__\t/r/a\n## dev\n M x.ts\n__AC_END__\n";
    const run = vi.fn(async (_c: string, _m: string, _a: string[], opts?: { onStdoutChunk?: (c: string, s: string) => void }) => {
      opts?.onStdoutChunk?.(stdout, stdout);
      return { code: 0, stdout, stderr: "" };
    });
    const out = await loadRepoStatusesBulk({ kind: "ssh", run } as never, ["/r/a"], { badgeOnly: true });
    expect((run.mock.calls[0] as unknown[])[3]).toMatchObject({ stdin: expect.stringContaining("untracked='no'") });
    expect(out[0]).toMatchObject({ modified: 1, untracked: 0, untrackedScanned: false });
  });

  it("single repo: badge scan runs --untracked-files=normal", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "## dev\n?? notes.txt\n", stderr: "" }));
    const st = await loadRepoStatus({ kind: "local", run } as never, "/r/a", { badgeOnly: true, scanUntracked: true });
    expect((run.mock.calls[0] as unknown[])[2]).toContain("--untracked-files=normal");
    expect(st).toMatchObject({ untracked: 1, untrackedScanned: true });
  });
});
