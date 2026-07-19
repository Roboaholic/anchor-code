import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  compareCommits,
  compareToWorktree,
  discoverRepos,
  getFileDiff,
  loadLog,
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
});
