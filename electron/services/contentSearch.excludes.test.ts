import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import { HostError, type HostSession, type RunOptions, type RunResult } from "../host/types.js";
import {
  anchorIgnoreToPatterns,
  invalidateAnchorIgnoreCache,
  mergeAnchorIgnore,
  searchWorkspaceContent,
} from "./contentSearch.js";

describe(".anchorignore helpers", () => {
  it("converts gitignore lines to post-filter patterns (skips comments/negations)", () => {
    expect(anchorIgnoreToPatterns("# c\n\n/generated/\n*.snap\n!keep.snap\nfixtures\n")).toEqual([
      "generated",
      "*.snap",
      "fixtures",
    ]);
  });

  it("merges without duplicates and adds a header to new files", () => {
    expect(mergeAnchorIgnore("", ["dist"])).toMatch(/^# Anchor Code.*\ndist\n$/s);
    expect(mergeAnchorIgnore("dist\n", ["dist", "out"])).toBe("dist\nout\n");
    expect(mergeAnchorIgnore("dist", ["dist"])).toBe("dist");
    expect(mergeAnchorIgnore("a", ["b"])).toBe("a\nb\n");
  });
});

describe("searchWorkspaceContent excludes + cancel (local rg)", () => {
  let tmp: string;
  let host: LocalHostSession;

  beforeEach(async () => {
    invalidateAnchorIgnoreCache();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-excl-"));
    host = new LocalHostSession("excl-test");
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.mkdir(path.join(tmp, "generated"), { recursive: true });
    await fs.mkdir(path.join(tmp, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "a.ts"), "needle 中文\n");
    await fs.writeFile(path.join(tmp, "generated", "g.ts"), "needle\n");
    await fs.writeFile(path.join(tmp, "node_modules", "pkg", "i.js"), "needle\n");
    await fs.writeFile(path.join(tmp, ".hidden.ts"), "needle\n");
    await fs.writeFile(path.join(tmp, ".gitignore"), "ignored.ts\n");
    await fs.writeFile(path.join(tmp, "ignored.ts"), "needle\n");
    // rg only honors .gitignore inside a git repo unless told otherwise
    await fs.mkdir(path.join(tmp, ".git"));
  });

  afterEach(async () => {
    await host.dispose();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const paths = (r: { hits: { path: string }[] }) => [...new Set(r.hits.map((h) => h.path))].sort();

  it("respects .gitignore, hidden and default excludes by default", async () => {
    const r = await searchWorkspaceContent(host, tmp, "needle");
    expect(r.source).toBe("rg");
    expect(paths(r)).toEqual(["generated/g.ts", "src/a.ts"]);
    expect(r.hits.find((h) => h.path === "src/a.ts")?.text).toBe("needle 中文");
  });

  it("respectIgnore=false searches ignored, hidden and node_modules", async () => {
    const r = await searchWorkspaceContent(host, tmp, "needle", { respectIgnore: false });
    expect(paths(r)).toEqual([
      ".hidden.ts",
      "generated/g.ts",
      "ignored.ts",
      "node_modules/pkg/i.js",
      "src/a.ts",
    ]);
  });

  it("honors .anchorignore via rg --ignore-file", async () => {
    await fs.writeFile(path.join(tmp, ".anchorignore"), "generated/\n");
    const r = await searchWorkspaceContent(host, tmp, "needle");
    expect(paths(r)).toEqual(["src/a.ts"]);
    const off = await searchWorkspaceContent(host, tmp, "needle", { useAnchorIgnore: false });
    expect(paths(off)).toContain("generated/g.ts");
    const ignoreRulesOff = await searchWorkspaceContent(host, tmp, "needle", { respectIgnore: false });
    expect(paths(ignoreRulesOff)).not.toContain("generated/g.ts");
    expect(ignoreRulesOff.diagnostics?.find((d) => d.code === "anchorignore")?.message).toContain("even when the ignore-rules checkbox is off");
  });

  it("custom default excludes replace built-ins", async () => {
    const r = await searchWorkspaceContent(host, tmp, "needle", { defaultExcludes: ["generated"] });
    expect(paths(r)).toEqual(["node_modules/pkg/i.js", "src/a.ts"]);
  });

  it("excludeRegex is a post-filter on paths; bad regex errors", async () => {
    const r = await searchWorkspaceContent(host, tmp, "needle", { excludeRegex: "^gen" });
    expect(paths(r)).toEqual(["src/a.ts"]);
    await expect(
      searchWorkspaceContent(host, tmp, "needle", { excludeRegex: "(" }),
    ).rejects.toThrow(/exclude regex/);
  });

  it("an aborted signal returns a partial result without falling back", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await searchWorkspaceContent(host, tmp, "needle", { signal: ctl.signal });
    expect(r.aborted).toBe(true);
    expect(r.source).toBe("rg");
  });
});

/** Minimal fake WSL host exposing the search surface. */
function fakeWsl(
  runSearch: (cwd: string, cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>,
  rg: string | null = "/home/u/.cache/anchor/rg",
) {
  const calls: { cmd: string; args: string[] }[] = [];
  let installs = 0;
  const host = {
    id: `wsl-fake-${Math.random()}`,
    kind: "wsl" as const,
    profileId: "wsl",
    readFile: async () => {
      throw new HostError("not_found", "nope");
    },
    run: async () => ({ stdout: "", stderr: "", code: 1 }),
    ensureSearchTools: async () => {
      installs += 1;
      return { rg };
    },
    runSearch: async (cwd: string, cmd: string, args: string[], opts?: RunOptions) => {
      calls.push({ cmd, args });
      return runSearch(cwd, cmd, args, opts);
    },
  };
  return { host: host as unknown as HostSession, calls, installs: () => installs };
}

describe("WSL native search (mocked host)", () => {
  beforeEach(() => invalidateAnchorIgnoreCache());

  it("uses the installed ~/.cache/anchor rg via runSearch (no chmod, no login shell)", async () => {
    const { host, calls } = fakeWsl(async (_c, _cmd, _a, opts) => {
      opts?.onStdoutChunk?.("src/a.ts:1:needle\n", "src/a.ts:1:needle\n");
      opts?.earlyExit?.("src/a.ts:1:needle\n", "");
      return { stdout: "src/a.ts:1:needle\n", stderr: "", code: 0 };
    });
    const r = await searchWorkspaceContent(host, "/repo", "needle");
    expect(r.hits).toEqual([{ path: "src/a.ts", line: 1, text: "needle" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("/home/u/.cache/anchor/rg");
    expect(calls.some((c) => c.cmd === "chmod")).toBe(false);
    expect(calls[0]!.args).toContain("--line-buffered");
  });

  it("a timeout keeps native rg enabled for the next search", async () => {
    let n = 0;
    const { host, calls } = fakeWsl(async () => {
      n += 1;
      if (n === 1) throw new HostError("timeout", "Command timed out after 45s");
      return { stdout: "a.ts:2:x\n", stderr: "", code: 0 };
    });
    const first = await searchWorkspaceContent(host, "/repo", "xx");
    expect(first.status).toBe("failed");
    expect(first.truncated).toBe(false); // timeout is incomplete coverage, not pagination
    expect(first.diagnostics?.some((d) => d.code === "timeout")).toBe(true);
    const second = await searchWorkspaceContent(host, "/repo", "xx");
    expect(second.hits).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("passes the abort signal through and reports aborted", async () => {
    const ctl = new AbortController();
    const { host } = fakeWsl(async (_c, _cmd, _a, opts) => {
      expect(opts?.signal).toBe(ctl.signal);
      ctl.abort();
      return { stdout: "", stderr: "", code: 0, aborted: true };
    });
    const r = await searchWorkspaceContent(host, "/repo", "needle", { signal: ctl.signal });
    expect(r.aborted).toBe(true);
  });
});
