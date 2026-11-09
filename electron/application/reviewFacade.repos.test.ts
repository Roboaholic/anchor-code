import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostManager } from "../host/hostManager.js";
import { LocalHostSession } from "../host/localHost.js";
import { branchFromHeadLine } from "../services/historyService.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";
import { ReviewFacade } from "./reviewFacade.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, stdio: "pipe" });
}

/** The real local host, reported as SSH so the remote (one-script) paths run. */
function asSsh(h: LocalHostSession) {
  const runs: string[] = [];
  const p = new Proxy(h, {
    get(t, k) {
      if (k === "kind") return "ssh";
      const v = Reflect.get(t, k) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (k === "run") runs.push(`${String(args[1])} ${(args[2] as string[]).join(" ")}`);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { host: p as unknown as LocalHostSession, runs };
}

describe("Repos panel over SSH: discovery branches and repo approval", () => {
  let ws: string;
  let host: LocalHostSession;
  const names = ["alpha", "beta", "gamma"];

  beforeEach(async () => {
    ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "anchor-repos-")));
    for (const n of names) {
      const r = path.join(ws, n);
      await fs.mkdir(r);
      git(r, ["init", "-q", "-b", n === "beta" ? "feature/x" : "main"]);
      await fs.writeFile(path.join(r, "f.txt"), "x\n");
      git(r, ["add", "."]);
      git(r, ["commit", "-qm", "init"]);
    }
    // gamma: detached HEAD → no branch from discovery (status decides)
    git(path.join(ws, "gamma"), ["checkout", "-q", "--detach"]);
    // a linked worktree (.git is a gitfile)
    git(path.join(ws, "alpha"), ["worktree", "add", "-q", "-b", "wt-branch", path.join(ws, "wt")]);
    host = new LocalHostSession();
  });
  afterEach(async () => {
    await host.dispose();
    await fs.rm(ws, { recursive: true, force: true });
  });

  function facade(h: LocalHostSession) {
    const workspace = {
      root: () => ws,
      safePath: (p?: string | null) => (p ? path.resolve(ws, p) : ws),
    } as unknown as WorkspaceFacade;
    return new ReviewFacade(new HostManager(h), workspace);
  }

  it("reads each repo's branch in the discovery scan (no extra command)", async () => {
    const { host: ssh, runs } = asSsh(host);
    const repos = await facade(ssh).repos(ws);
    const byName = Object.fromEntries(repos.map((r) => [r.name, r.branch]));
    expect(byName).toEqual({ alpha: "main", beta: "feature/x", gamma: undefined, wt: "wt-branch" });
    expect(runs).toHaveLength(1);
  });

  it("approves discovered roots without a per-repo git rev-parse before bulk status", async () => {
    const { host: ssh, runs } = asSsh(host);
    const review = facade(ssh);
    const repos = await review.repos(ws);
    runs.length = 0;
    const statuses = await review.statusBulk(repos.map((r) => r.root), { badgeOnly: true });
    expect(statuses.map((s) => s.branch).sort()).toEqual(["feature/x", "main", "wt-branch", null].sort());
    expect(runs).toHaveLength(1); // just the one status script
    expect(runs.some((r) => r.includes("rev-parse"))).toBe(false);
  });

  it("checks roots outside the discovery cache in one command and still rejects non-roots", async () => {
    const { host: ssh, runs } = asSsh(host);
    const review = facade(ssh);
    const roots = names.map((n) => path.join(ws, n));
    await review.statusBulk(roots, { badgeOnly: true });
    expect(runs.filter((r) => r.startsWith("bash -s"))).toHaveLength(2); // approval batch + status
    expect(runs.some((r) => r.startsWith("git rev-parse"))).toBe(false);
    await fs.mkdir(path.join(ws, "alpha", "sub"));
    await expect(review.statusBulk([path.join(ws, "alpha", "sub"), roots[1]!])).rejects.toMatchObject({ code: "permission" });
    await expect(review.status(path.join(ws, "alpha", "sub"))).rejects.toMatchObject({ code: "permission" });
  });

  it("parses HEAD lines", () => {
    expect(branchFromHeadLine("ref: refs/heads/release/1.2\n")).toBe("release/1.2");
    expect(branchFromHeadLine("0123456789abcdef0123456789abcdef01234567")).toBeNull();
    expect(branchFromHeadLine("")).toBeNull();
  });
});
