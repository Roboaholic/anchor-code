import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostError, type HostSession, type RunOptions, type RunResult } from "../host/types.js";
import { findWorkspaceFiles } from "./fileIndex.js";
import {
  classifyRgExit,
  invalidateAnchorIgnoreCache,
  rgRejectedFlags,
  rgTimeoutMs,
  searchWorkspaceContent,
} from "./contentSearch.js";

vi.mock("./fileIndex.js", () => ({ findWorkspaceFiles: vi.fn() }));

const res = (stdout: string, code: number, stderr = ""): RunResult => ({ stdout, code, stderr });
let sequence = 0;
function fixture() {
  const run = vi.fn<HostSession["run"]>().mockResolvedValue(res("", 1));
  const readFile = vi.fn<HostSession["readFile"]>().mockRejectedValue(new HostError("not_found", "No such file"));
  const stat = vi.fn<HostSession["stat"]>().mockResolvedValue({ isDir: true, isFile: false, size: 0, mtimeMs: 0 });
  const host = { id: `rg-exit-${++sequence}`, kind: "ssh", run, readFile, stat } as unknown as HostSession;
  return { host, run };
}
/** Stream stdout through earlyExit like a real host, then exit with `code`. */
function streamed(stdout: string, code: number, stderr = "") {
  return async (_cwd: string, _cmd: string, _args: string[], opts?: RunOptions) => {
    opts?.earlyExit?.(stdout, stderr);
    return res(stdout, code, stderr);
  };
}
const codes = (r: Awaited<ReturnType<typeof searchWorkspaceContent>>) => r.diagnostics?.map((d) => d.code);

// Verbatim stderr from ripgrep 0.10.0 / 13.0.0 / 14.1.1.
const CLAP2_REJECTED = "error: Found argument '--max-columns-preview' which wasn't expected, or isn't valid in this context\n\tDid you mean --max-columns?\n\nUSAGE:\n    rg [OPTIONS] PATTERN [PATH ...]\n\nFor more information try --help\n";
const RG14_REJECTED = "rg: unrecognized flag --max-columns-preview\n";
const HIT = "svc/res/Res_ADAS.c:284:  .FormatName = \"Mode0-2:VIN_0[3072x3072p30_DCG]\",\n";

beforeEach(() => {
  invalidateAnchorIgnoreCache();
  vi.mocked(findWorkspaceFiles).mockReset();
});

describe("rgRejectedFlags", () => {
  it("recognizes old clap usage errors (exit 1 in rg 0.10, exit 2 in rg 13) and rg 14", () => {
    expect(rgRejectedFlags(res("", 1, CLAP2_REJECTED))).toBe(true);
    expect(rgRejectedFlags(res("", 2, CLAP2_REJECTED))).toBe(true);
    expect(rgRejectedFlags(res("", 2, RG14_REJECTED))).toBe(true);
    expect(rgRejectedFlags(res("a.c:1:x\n", 2, RG14_REJECTED))).toBe(false);
    expect(rgRejectedFlags(res("", 2, "rg: ./locked: Permission denied (os error 13)\n"))).toBe(false);
  });
});

describe("classifyRgExit", () => {
  it("treats per-path errors as skipped paths, not a failed search", () => {
    expect(classifyRgExit(res(HIT, 2, "rg: ./locked: Permission denied (os error 13)\n"))).toEqual({
      ok: true, skippedPaths: ["./locked: Permission denied (os error 13)"],
    });
    // rg 11/12 print no "rg:" prefix; rg 13+ exits 2 even with no matches.
    expect(classifyRgExit(res("", 2, "./a/b: Permission denied (os error 13)\n./gone.c: No such file or directory (os error 2)\n"))).toEqual({
      ok: true, skippedPaths: ["./a/b: Permission denied (os error 13)", "./gone.c: No such file or directory (os error 2)"],
    });
    expect(classifyRgExit(res(HIT, 0, "rg: sub/.gitignore: line 1: error parsing glob '[': unclosed character class; missing ']'\n"))).toMatchObject({ ok: true });
    expect(classifyRgExit(res("", 1, "No files were searched, which means ripgrep probably applied a filter you didn't expect.\n"))).toEqual({ ok: true, skippedPaths: [] });
  });

  it("still fails for shell, root, usage and unknown errors", () => {
    expect(classifyRgExit(res("", 1, "bash: cd: /repo: No such file or directory\n"))).toEqual({ ok: false });
    expect(classifyRgExit(res("", 2, "rg: .: Permission denied (os error 13)\n"))).toEqual({ ok: false });
    expect(classifyRgExit(res("", 2, "rg: regex parse error:\n    (?:[)\n       ^\nerror: unclosed character class\n"))).toEqual({ ok: false });
    expect(classifyRgExit(res("", 2, ""))).toEqual({ ok: false });
    expect(classifyRgExit(res("", 1, CLAP2_REJECTED))).toEqual({ ok: false });
    expect(classifyRgExit(res("", 127, "bash: rg: command not found\n"))).toEqual({ ok: false });
    expect(classifyRgExit(res("", 255, "Connection reset by peer\n"))).toEqual({ ok: false });
  });
});

describe("remote rg exit handling", () => {
  it("passes the include glob as one argv element (no shell expansion)", async () => {
    const { host, run } = fixture();
    run.mockImplementationOnce(streamed(HIT, 0));
    await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    const args = run.mock.calls[0]![2];
    const i = args.lastIndexOf("--glob");
    expect(args[i + 1]).toBe("**/*.c");
    expect(args.slice(-3)).toEqual(["--", "3072x3072p30_DCG", "."]);
    expect(args).toContain("-F");
    expect(args).toContain("-i");
  });

  it("retries an old rg (0.10 exits 1 on unknown flags) in compatibility mode and keeps using it", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(res("", 1, CLAP2_REJECTED));
    run.mockImplementationOnce(streamed(HIT, 0));
    const first = await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    expect(first).toMatchObject({ status: "complete", source: "rg" });
    expect(first.hits).toHaveLength(1);
    expect(codes(first)).toContain("rg-compatibility");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![2]).toContain("--max-columns-preview");
    expect(run.mock.calls[1]![2]).not.toContain("--max-columns-preview");

    run.mockImplementationOnce(streamed(HIT, 0));
    const second = await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    expect(second.hits).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]![2]).not.toContain("--max-columns-preview");
  });

  it("retries rg 13's exit-2 clap rejection too", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(res("", 2, CLAP2_REJECTED));
    run.mockImplementationOnce(streamed(HIT, 0));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result.hits).toHaveLength(1);
    expect(result.status).toBe("complete");
  });

  it("shows matches and a warning when some paths are unreadable", async () => {
    const { host, run } = fixture();
    run.mockImplementationOnce(streamed(HIT, 2, "rg: ./locked: Permission denied (os error 13)\n"));
    const result = await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    expect(result).toMatchObject({ status: "complete", source: "rg" });
    expect(result.hits.map((h) => h.path)).toEqual(["svc/res/Res_ADAS.c"]);
    const warning = result.diagnostics?.find((d) => d.code === "unreadable-paths");
    expect(warning?.message).toContain("./locked: Permission denied");
    expect(codes(result)).not.toContain("failed");
  });

  it("reports no matches (with the skipped paths) instead of failure when rg exits 2 without hits", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(res("", 2, "rg: ./locked: Permission denied (os error 13)\n"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ status: "complete", hits: [] });
    expect(codes(result)).toContain("unreadable-paths");
  });

  it("summarizes many skipped paths", async () => {
    const { host, run } = fixture();
    const stderr = Array.from({ length: 8 }, (_, i) => `rg: ./d${i}: Permission denied (os error 13)`).join("\n");
    run.mockImplementationOnce(streamed(HIT, 2, stderr));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    const warning = result.diagnostics?.find((d) => d.code === "unreadable-paths");
    expect(warning?.message).toMatch(/^8 paths were skipped/);
    expect(warning?.message).toContain("(+3 more)");
  });
});

describe("remote rg timeout", () => {
  it("gives remote rg a longer budget than local", async () => {
    const { host, run } = fixture();
    run.mockImplementationOnce(streamed(HIT, 0));
    await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    expect(run.mock.calls[0]![3]?.timeoutMs).toBe(90_000);
    expect(rgTimeoutMs({ kind: "local" })).toBe(15_000);
    expect(rgTimeoutMs({ kind: "wsl" })).toBe(90_000);
  });

  it("reports a timeout as timed out and keeps hits streamed before it", async () => {
    const { host, run } = fixture();
    run.mockImplementationOnce(async () => { throw new HostError("timeout", "SSH search timed out after 90000ms: rg"); });
    const empty = await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    expect(empty).toMatchObject({ status: "failed", source: "rg", hits: [] });
    expect(empty.diagnostics?.[0]).toMatchObject({ code: "timeout" });
    expect(empty.diagnostics?.[0]?.message).toMatch(/timed out.*No match was found before the time limit/);

    run.mockImplementationOnce(async (_c, _cmd, _a, opts) => {
      opts?.earlyExit?.(HIT, "");
      throw new HostError("timeout", "SSH search timed out after 90000ms: rg");
    });
    const partial = await searchWorkspaceContent(host, "/repo", "3072x3072p30_DCG", { include: "*.c" });
    expect(partial).toMatchObject({ status: "partial", source: "rg" });
    expect(partial.hits.map((h) => `${h.path}:${h.line}`)).toEqual(["svc/res/Res_ADAS.c:284"]);
    expect(partial.diagnostics?.[0]?.message).toMatch(/Matches found before the time limit are kept/);
  });
});
