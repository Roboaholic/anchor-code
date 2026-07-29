import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  checkoutBranch,
  commitChanges,
  compareCommits,
  compareToWorktree,
  discoverRepos,
  getFileDiff,
  loadFileBlame,
  listBranches,
  loadLog,
  loadRepoStatus,
} from "./historyService.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("historyService (integration, temp git repo)", () => {
  let root: string;
  let host: LocalHostSession;
  let hashA: string;
  let hashB: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-hist-"));
    host = new LocalHostSession("hist-test");
    host.workspaceRoot = root;

    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);

    await fs.writeFile(path.join(root, "app.ts"), "export const n = 1\n", "utf8");
    git(root, ["add", "app.ts"]);
    git(root, ["commit", "-m", "first"]);
    hashA = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    await fs.writeFile(path.join(root, "app.ts"), "export const n = 2\n", "utf8");
    await fs.writeFile(path.join(root, "new.ts"), "export const x = 1\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "second"]);
    hashB = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    // dirty worktree
    await fs.writeFile(path.join(root, "app.ts"), "export const n = 3\n", "utf8");
  });

  afterEach(async () => {
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("discovers the git root under workspace", async () => {
    const repos = await discoverRepos(host, root);
    expect(repos.map((r) => r.root)).toContain(path.resolve(root));
  });

  it("loads commit log with subjects", async () => {
    const commits = await loadLog(host, root);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits.some((c) => c.subject === "second")).toBe(true);
    expect(commits.some((c) => c.hash === hashB)).toBe(true);
  });

  it("loads line attribution for a tracked file", async () => {
    const blame = await loadFileBlame(host, root, path.join(root, "new.ts"));
    expect(blame).toHaveLength(1);
    expect(blame[0]).toMatchObject({
      line: 1,
      author: "Test",
      subject: "second",
    });
    expect(blame[0]!.hash).toBe(hashB);
    expect(blame[0]!.shortHash).toBe(hashB.slice(0, 8));
  });

  it("compares two commits and returns file list", async () => {
    const payload = await compareCommits(host, root, hashA, hashB);
    expect(payload.base).toBe(hashA);
    expect(payload.head).toBe(hashB);
    expect(payload.files.map((f) => f.path).sort()).toEqual(
      ["app.ts", "new.ts"].sort(),
    );

    const diff = await getFileDiff(
      host,
      root,
      hashA,
      hashB,
      "app.ts",
      "M",
    );
    expect(diff.oldText).toContain("n = 1");
    expect(diff.newText).toContain("n = 2");
  });

  it("compares commit to worktree", async () => {
    const payload = await compareToWorktree(host, root, hashB);
    expect(payload.head).toBe("worktree");
    expect(payload.files.some((f) => f.path === "app.ts")).toBe(true);

    const diff = await getFileDiff(
      host,
      root,
      hashB,
      "worktree",
      "app.ts",
      "M",
    );
    expect(diff.oldText).toContain("n = 2");
    expect(diff.newText).toContain("n = 3");
  });

  it("loads porcelain status and includes untracked in worktree compare", async () => {
    await fs.writeFile(path.join(root, "scratch.tmp"), "hi\n", "utf8");
    const status = await loadRepoStatus(host, root);
    expect(status.entries.some((e) => e.path === "app.ts")).toBe(true);
    expect(status.entries.some((e) => e.path === "scratch.tmp" && e.status === "?")).toBe(
      true,
    );
    expect(status.untracked).toBeGreaterThanOrEqual(1);
    // Default branch name varies (master vs main depending on git config).
    expect(status.branch).toBeTruthy();

    const payload = await compareToWorktree(host, root, "HEAD");
    expect(payload.files.some((f) => f.path === "scratch.tmp" && f.status === "?")).toBe(
      true,
    );
    const diff = await getFileDiff(
      host,
      root,
      "HEAD",
      "worktree",
      "scratch.tmp",
      "?",
    );
    expect(diff.oldText).toBe("");
    expect(diff.newText).toContain("hi");
  });

  it("lists branches, checkouts, and commits working tree changes", async () => {
    const initial = await loadRepoStatus(host, root);
    const baseBranch = initial.branch;
    expect(baseBranch).toBeTruthy();

    git(root, ["branch", "feature-hist"]);
    const branches = await listBranches(host, root);
    expect(branches.some((b) => b.name === "feature-hist")).toBe(true);
    expect(branches.some((b) => b.current)).toBe(true);

    // Dirty worktree may block checkout of unrelated changes — commit first path.
    const committed = await commitChanges(host, root, "wip before switch");
    expect(committed.subject).toBe("wip before switch");
    expect(committed.hash.length).toBeGreaterThanOrEqual(7);

    const clean = await loadRepoStatus(host, root);
    expect(clean.modified + clean.added + clean.deleted + clean.untracked).toBe(
      0,
    );

    const switched = await checkoutBranch(host, root, "feature-hist");
    expect(switched.branch).toBe("feature-hist");
    const after = await loadRepoStatus(host, root);
    expect(after.branch).toBe("feature-hist");

    await fs.writeFile(path.join(root, "feat.ts"), "export const f = 1\n", "utf8");
    const c2 = await commitChanges(host, root, "add feat");
    expect(c2.subject).toBe("add feat");

    // Switch back
    await checkoutBranch(host, root, baseBranch!);
    const back = await loadRepoStatus(host, root);
    expect(back.branch).toBe(baseBranch);
  });
});
