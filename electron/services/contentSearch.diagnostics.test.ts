import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostError, type HostSession, type RunOptions, type RunResult } from "../host/types.js";
import { findWorkspaceFiles } from "./fileIndex.js";
import { invalidateAnchorIgnoreCache, searchWorkspaceContent } from "./contentSearch.js";

vi.mock("./fileIndex.js", () => ({ findWorkspaceFiles: vi.fn() }));

const ok = (stdout = "", code = stdout ? 0 : 1, stderr = ""): RunResult => ({ stdout, code, stderr });
let sequence = 0;
function fixture() {
  const run = vi.fn<HostSession["run"]>().mockResolvedValue(ok());
  const readFile = vi.fn<HostSession["readFile"]>().mockRejectedValue(new HostError("not_found", "No such file"));
  const stat = vi.fn<HostSession["stat"]>().mockResolvedValue({ isDir: true, isFile: false, size: 0, mtimeMs: 0 });
  const host = { id: `diagnostic-${++sequence}`, kind: "ssh", run, readFile, stat } as unknown as HostSession;
  return { host, run, readFile, stat };
}
function emit(opts?: RunOptions, stdout = "src/fixture.c:2:needle\n") {
  opts?.earlyExit?.(stdout, "");
  return stdout;
}
const codes = (r: Awaited<ReturnType<typeof searchWorkspaceContent>>) => r.diagnostics?.map((d) => d.code);

beforeEach(() => {
  invalidateAnchorIgnoreCache();
  vi.mocked(findWorkspaceFiles).mockReset();
  vi.mocked(findWorkspaceFiles).mockResolvedValue({ root: "/repo", files: [], truncated: false, source: "walk" });
});

describe("content search failures and coverage", () => {
  it("distinguishes a completed no-match search from failed or limited searches", async () => {
    const { host, run } = fixture();
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ source: "rg", status: "complete", hits: [], truncated: false });
    expect(codes(result)).toContain("rg-scope");
    expect(result.diagnostics?.[0]?.message).toMatch(/512 KiB.*Review filters/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "disconnected", "permission"] as const)("retains streamed hits on %s without falling back", async (code) => {
    const { host, run } = fixture();
    const onHits = vi.fn();
    run.mockImplementationOnce(async (_cwd, _cmd, _args, opts) => {
      emit(opts);
      throw new HostError(code, "Synthetic host failure");
    });
    const result = await searchWorkspaceContent(host, "/repo", "needle", { onHits });
    expect(result).toMatchObject({ status: "partial", source: "rg", truncated: false });
    expect(result.hits).toEqual([{ path: "src/fixture.c", line: 2, text: "needle" }]);
    expect(onHits).toHaveBeenCalledOnce();
    expect(codes(result)).toContain(code);
    expect(run).toHaveBeenCalledTimes(1);
    expect(findWorkspaceFiles).not.toHaveBeenCalled();
    const retry = await searchWorkspaceContent(host, "/repo", "needle");
    expect(retry.source).toBe("rg");
    expect(run.mock.calls[1]?.[1]).toBe("rg");
  });

  it("reports SSH exit 255 with zero hits as failure, not no matches", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(ok("", 255, "Connection reset by peer"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ status: "failed", hits: [], source: "rg" });
    expect(result.diagnostics?.[0]?.message).toContain("Connection reset by peer");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not report shell/cwd exit 1 as a clean no-match search", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(ok("", 1, "bash: cd: /repo: No such file or directory"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ status: "failed", source: "rg", hits: [] });
    expect(result.diagnostics?.[0]?.message).toContain("No such file or directory");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps partial output from rg exit 2 without hiding the error behind git", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(ok("a.c:3:needle", 2, "locked/: Permission denied"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result.status).toBe("partial");
    expect(result.hits).toHaveLength(1);
    expect(result.diagnostics?.[0]?.message).toContain("Permission denied");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("labels confirmed missing-rg fallback tracked-only, including zero matches, and retries rg next time", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(ok("", 127, "rg: command not found")).mockResolvedValueOnce(ok());
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ status: "partial", source: "git-grep", hits: [], truncated: false });
    expect(codes(result)).toContain("tracked-only");
    expect(run.mock.calls.map((c) => c[1])).toEqual(["rg", "git"]);
    expect((await searchWorkspaceContent(host, "/repo", "needle")).source).toBe("rg");
    expect(run.mock.calls[2]?.[1]).toBe("rg");
  });

  it("does not scan behind selected ignore rules if rg and git are unavailable", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(ok("", 127, "rg: command not found"))
      .mockResolvedValueOnce(ok("", 128, "fatal: not a git repository"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("engine-unavailable");
    expect(findWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("keeps git fallback hits and error without attempting another engine", async () => {
    const { host, run } = fixture();
    run.mockResolvedValueOnce(ok("", 127)).mockImplementationOnce(async (_cwd, _cmd, _args, opts) => {
      emit(opts);
      throw new HostError("timeout", "git timed out");
    });
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ source: "git-grep", status: "partial", truncated: false });
    expect(result.hits).toHaveLength(1);
    expect(codes(result)).toEqual(expect.arrayContaining(["timeout", "tracked-only"]));
    expect(findWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("fails closed when .anchorignore cannot be read", async () => {
    const { host, run, readFile } = fixture();
    readFile.mockRejectedValue(new HostError("permission", "Cannot read .anchorignore"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result.status).toBe("failed");
    expect(codes(result)).toContain("ignore-file-error");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves cancellation without fallback or a pageable result limit", async () => {
    const { host, run } = fixture();
    const ctl = new AbortController();
    run.mockImplementationOnce(async (_cwd, _cmd, _args, opts) => {
      const stdout = emit(opts);
      ctl.abort();
      return { ...ok(stdout), aborted: true };
    });
    const result = await searchWorkspaceContent(host, "/repo", "needle", { signal: ctl.signal });
    expect(result).toMatchObject({ status: "cancelled", aborted: true, truncated: false });
    expect(result.hits).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports the scan's index/size/read gaps without offering impossible extra pages", async () => {
    const { host, run, stat, readFile } = fixture();
    run.mockResolvedValueOnce(ok("", 127));
    vi.mocked(findWorkspaceFiles).mockResolvedValue({
      root: "/repo", files: ["small.c", "large.c", "locked.c"], source: "walk", truncated: true,
    });
    stat.mockImplementation(async (path) => ({
      isDir: path === "/repo", isFile: path !== "/repo", mtimeMs: 0,
      size: path.endsWith("large.c") ? 256 * 1024 + 1 : 32,
    }));
    readFile.mockImplementation(async (path) => {
      if (path.endsWith(".anchorignore")) throw new HostError("not_found", "missing");
      if (path.endsWith("locked.c")) throw new HostError("permission", "locked.c: permission denied");
      return "needle\n";
    });
    const result = await searchWorkspaceContent(host, "/repo", "needle", { respectIgnore: false });
    expect(result).toMatchObject({ source: "scan", status: "partial", truncated: false });
    expect(result.hits).toEqual([{ path: "small.c", line: 1, text: "needle" }]);
    expect(codes(result)).toEqual(expect.arrayContaining(["scan-scope", "index-limit", "files-too-large", "unreadable-files"]));
    expect(readFile.mock.calls.some(([path]) => path.endsWith("large.c"))).toBe(false);
  });

  it("still enforces explicit exclusions during the bounded scan", async () => {
    const { host, run, stat, readFile } = fixture();
    run.mockResolvedValueOnce(ok("", 127));
    vi.mocked(findWorkspaceFiles).mockResolvedValue({ root: "/repo", files: ["private/secret.c"], source: "walk", truncated: false });
    const result = await searchWorkspaceContent(host, "/repo", "needle", { respectIgnore: false, exclude: ["private"] });
    expect(result).toMatchObject({ source: "scan", status: "partial", hits: [] });
    expect(stat).toHaveBeenCalledTimes(1); // workspace only, excluded file never touched
    expect(readFile).toHaveBeenCalledTimes(1); // ignore file only
  });

  it("does not mistake a missing cwd for a missing executable", async () => {
    const { host, run, stat } = fixture();
    run.mockRejectedValue(new HostError("failed", "Failed to run rg", "spawn rg ENOENT"));
    stat.mockRejectedValue(new HostError("not_found", "workspace missing"));
    const result = await searchWorkspaceContent(host, "/repo", "needle");
    expect(result).toMatchObject({ source: "rg", status: "failed" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
