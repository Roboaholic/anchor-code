import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import type { SnapshotMeta } from "../../src/core/snapshots/model.js";
import { SnapshotService, buildRemoteScript, createFileIndexStore, parseProgressLines, parseRemoteResults, type SnapshotIndexStore } from "./snapshotService.js";
import type { SnapshotProgress } from "../../src/core/snapshots/model.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@e.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@e.com",
};
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });
}
async function write(p: string, data: string | Buffer) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
}
async function sha(file: string) {
  return createHash("sha1").update(await fs.readFile(file)).digest("hex");
}
function memoryIndex(): SnapshotIndexStore {
  const m = new Map<string, SnapshotMeta[]>();
  return {
    load: async (k) => structuredClone(m.get(k) ?? []),
    save: async (k, l) => void m.set(k, structuredClone(l)),
  };
}

let ws: string;
let a: string;
let b: string;
let storeBase: string;
let host: LocalHostSession;
let svc: SnapshotService;
let clock: number;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-snap-"));
  storeBase = path.join(ws, ".appdata");
  a = path.join(ws, "a");
  b = path.join(ws, "b");
  for (const r of [a, b]) {
    await fs.mkdir(r, { recursive: true });
    git(r, ["init", "-q", "-b", "main"]);
    await write(path.join(r, "keep.txt"), "base\n");
    await write(path.join(r, ".gitignore"), "ignored.log\n");
    git(r, ["add", "."]);
    git(r, ["commit", "-qm", "init"]);
  }
  host = new LocalHostSession();
  clock = Date.parse("2026-11-04T08:00:00Z");
  svc = new SnapshotService({
    index: memoryIndex(),
    localStoreBase: storeBase,
    largeFileBytes: 1024,
    now: () => clock,
  });
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

function lsTree(repo: string, rev: string): string[] {
  return git(repo, ["ls-tree", "-r", "--name-only", rev]).split("\n").filter(Boolean).sort();
}

describe("SnapshotService.create", () => {
  it("captures staged, unstaged and untracked files without touching index or worktree", async () => {
    await write(path.join(a, "staged.txt"), "s\n");
    git(a, ["add", "staged.txt"]);
    await write(path.join(a, "keep.txt"), "changed\n");
    await write(path.join(a, "new.txt"), "untracked\n");
    await write(path.join(a, "ignored.log"), "nope\n");
    const indexBefore = await sha(path.join(a, ".git/index"));
    const statusBefore = git(a, ["status", "--porcelain"]);

    const meta = await svc.create(host, { workspaceRoot: ws, repoRoots: [a, b], source: "manual" });

    expect(meta.name).toMatch(/^\d\d:\d\d$/);
    const ra = meta.repos.find((r) => r.root === a)!;
    expect(ra.status).toBe("ok");
    expect(ra.storage).toBe("repo");
    expect(lsTree(a, ra.commit)).toEqual([".gitignore", "keep.txt", "new.txt", "staged.txt"]);
    expect(git(a, ["show", `${ra.commit}:keep.txt`])).toBe("changed\n");
    expect(git(a, ["rev-parse", `refs/anchor/snapshots/${meta.id}`]).trim()).toBe(ra.commit);
    expect(git(a, ["rev-parse", `${ra.commit}^`]).trim()).toBe(ra.head);
    expect(await sha(path.join(a, ".git/index"))).toBe(indexBefore);
    expect(git(a, ["status", "--porcelain"])).toBe(statusBefore);
    expect((await fs.readdir(path.join(a, ".git"))).filter((f) => f.startsWith("anchor-snapshot-"))).toEqual([]);
  });

  it("skips large untracked files but records path, size and mtime", async () => {
    await write(path.join(a, "big.bin"), Buffer.alloc(4096, 1));
    const meta = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "manual", name: "  有大文件  " });
    const ra = meta.repos[0]!;
    expect(meta.name).toBe("有大文件");
    expect(lsTree(a, ra.commit)).not.toContain("big.bin");
    expect(ra.largeFiles).toHaveLength(1);
    expect(ra.largeFiles[0]).toMatchObject({ path: "big.bin", size: 4096 });

    await write(path.join(a, "big.bin"), Buffer.alloc(8192, 2));
    const diff = await svc.compare(host, { workspaceRoot: ws, repoRoots: [a], baseId: meta.id, targetId: "worktree" });
    expect(diff.repos[0]!.largeFiles).toEqual([{ path: "big.bin", size: 8192, status: "M" }]);
    expect(diff.repos[0]!.state).toBe("changed");
  });

  it("handles a repo with no commits", async () => {
    const c = path.join(ws, "c");
    await fs.mkdir(c);
    git(c, ["init", "-q"]);
    await write(path.join(c, "x.txt"), "x\n");
    const meta = await svc.create(host, { workspaceRoot: ws, repoRoots: [c], source: "manual" });
    expect(meta.repos[0]).toMatchObject({ status: "ok", head: null });
    expect(lsTree(c, meta.repos[0]!.commit)).toEqual(["x.txt"]);
  });

  it("records a per-repo error without failing other repos", async () => {
    const notGit = path.join(ws, "plain");
    await fs.mkdir(notGit);
    const meta = await svc.create(host, { workspaceRoot: ws, repoRoots: [a, path.join(notGit, "missing")], source: "manual" });
    expect(meta.repos.map((r) => r.status)).toEqual(["ok", "error"]);
  });

  it("stores snapshots outside the repo when a remote mirrors or pushes refs/*", async () => {
    git(a, ["config", "remote.origin.url", "/dev/null"]);
    git(a, ["config", "remote.origin.mirror", "true"]);
    await write(path.join(a, "keep.txt"), "mirror-edit\n");
    const meta = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    const ra = meta.repos[0]!;
    expect(ra.storage).toBe("external");
    expect(ra.storeDir!.startsWith(storeBase)).toBe(true);
    expect(git(a, ["for-each-ref", "refs/anchor"])).toBe("");
    expect(git(ra.storeDir!, ["rev-parse", `refs/anchor/snapshots/${meta.id}`]).trim()).toBe(ra.commit);
    // Snapshot survives an aggressive gc in the store.
    git(ra.storeDir!, ["gc", "-q", "--prune=now"]);
    expect(git(ra.storeDir!, ["show", `${ra.commit}:keep.txt`])).toBe("mirror-edit\n");
    const alt = await svc.alternatesFor(host, ws, a, [ra.commit]);
    expect(alt).toBe(path.join(ra.storeDir!, "objects"));

    await write(path.join(a, "keep.txt"), "later\n");
    const diff = await svc.compare(host, { workspaceRoot: ws, repoRoots: [a], baseId: meta.id, targetId: "worktree" });
    expect(diff.repos[0]!.files).toEqual([{ path: "keep.txt", status: "M" }]);
  });

  it("is never pushed with default refspecs", async () => {
    const bare = path.join(ws, "remote.git");
    git(ws, ["init", "-q", "--bare", bare]);
    git(a, ["remote", "add", "origin", bare]);
    const meta = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    expect(meta.repos[0]!.storage).toBe("repo");
    git(a, ["push", "-q", "origin", "main"]);
    git(a, ["push", "-q", "--all", "origin"]);
    git(a, ["push", "-q", "--tags", "origin"]);
    expect(git(bare, ["for-each-ref", "refs/anchor"])).toBe("");
  });
});

describe("SnapshotService.compare / list / rename / remove", () => {
  it("diffs two snapshots grouped by repo, collapsing unchanged and marking added repos", async () => {
    const s1 = await svc.create(host, { workspaceRoot: ws, repoRoots: [a, b], source: "manual" });
    clock += 60_000;
    await write(path.join(a, "keep.txt"), "v2\n");
    await write(path.join(a, "added.txt"), "n\n");
    const c = path.join(ws, "c");
    await fs.mkdir(c);
    git(c, ["init", "-q"]);
    await write(path.join(c, "z.txt"), "z\n");
    const s2 = await svc.create(host, { workspaceRoot: ws, repoRoots: [a, b, c], source: "auto", agentTabId: "t1", agentLabel: "Codex", turn: { index: 1, phase: "end" } });

    const diff = await svc.compare(host, { workspaceRoot: ws, repoRoots: [], baseId: s2.id, targetId: s1.id });
    expect(diff.baseId).toBe(s1.id); // reordered old → new
    const byName = Object.fromEntries(diff.repos.map((r) => [r.name, r]));
    expect(byName.a!.state).toBe("changed");
    expect(byName.a!.files).toEqual([
      { path: "added.txt", status: "A" },
      { path: "keep.txt", status: "M" },
    ]);
    expect(byName.b!.state).toBe("unchanged");
    expect(byName.c!.state).toBe("added");
    expect(diff.repos.at(-1)!.name).toBe("b");
  });

  it("marks an end snapshot with no changes as empty", async () => {
    const start = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "auto", turn: { index: 1, phase: "start" } });
    clock += 1000;
    const end = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "auto", turn: { index: 1, phase: "end" }, pairWithId: start.id });
    expect(end.empty).toBe(true);
  });

  it("lists newest first, renames in the index and deletes refs", async () => {
    const s1 = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    clock += 1000;
    const s2 = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    expect((await svc.list(host, ws)).map((s) => s.id)).toEqual([s2.id, s1.id]);
    await svc.rename(host, ws, s1.id, "改完接口");
    expect((await svc.list(host, ws)).find((s) => s.id === s1.id)!.name).toBe("改完接口");
    await svc.remove(host, ws, [s1.id]);
    expect((await svc.list(host, ws)).map((s) => s.id)).toEqual([s2.id]);
    expect(git(a, ["for-each-ref", "--format=%(refname)", "refs/anchor"]).trim()).toBe(`refs/anchor/snapshots/${s2.id}`);
  });

  it("applies retention to auto snapshots older than 30 days", async () => {
    const old = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "auto" });
    const manual = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    clock += 31 * 86_400_000;
    const fresh = await svc.create(host, { workspaceRoot: ws, repoRoots: [a], source: "auto" });
    const ids = (await svc.list(host, ws)).map((s) => s.id);
    expect(ids).toContain(manual.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);
  });
});

describe("SnapshotService index rebuild", () => {
  it("rebuilds a lost or corrupt index from repo refs and external stores", async () => {
    const indexDir = path.join(ws, ".index");
    const mk = () => new SnapshotService({ index: createFileIndexStore(indexDir), localStoreBase: storeBase, largeFileBytes: 1024, now: () => clock });
    git(b, ["config", "remote.origin.mirror", "true"]);
    const s1 = mk();
    await write(path.join(a, "keep.txt"), "one\n");
    const first = await s1.create(host, { workspaceRoot: ws, repoRoots: [a, b], name: "重构前", source: "manual" });
    clock += 60_000;
    const second = await s1.create(host, { workspaceRoot: ws, repoRoots: [a, b], source: "auto", agentLabel: "Codex", turn: { index: 1, phase: "end" } });
    const files = await fs.readdir(indexDir);
    expect(files).toHaveLength(1);

    for (const mode of ["missing", "corrupt"] as const) {
      const file = path.join(indexDir, files[0]!);
      if (mode === "missing") await fs.rm(file);
      else await fs.writeFile(file, "{not json");
      const list = await mk().list(host, ws, [a, b]);
      expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
      const r = list.find((s) => s.id === first.id)!;
      expect(r.name).toBe("重构前");
      expect(r.repos.map((e) => e.root).sort()).toEqual([a, b].sort());
      const eb = r.repos.find((e) => e.root === b)!;
      expect(eb.storage).toBe("external");
      expect(eb.commit).toBe(first.repos.find((e) => e.root === b)!.commit);
      expect(list.find((s) => s.id === second.id)!.agentLabel).toBe("Codex");
      // rebuilt index is persisted and usable for compare
      expect(JSON.parse(await fs.readFile(file, "utf8")).snapshots).toHaveLength(2);
      const diff = await mk().compare(host, { workspaceRoot: ws, repoRoots: [a, b], baseId: first.id, targetId: "worktree" });
      expect(diff.repos).toHaveLength(2);
    }
  });
});


/** Remote hosts take the batched one-script path; exercise it on a local repo. */
function asRemote(h: LocalHostSession) {
  const calls: string[] = [];
  const p = new Proxy(h, {
    get(t, k) {
      if (k === "kind") return "ssh";
      const v = Reflect.get(t, k) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(k));
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { host: p as unknown as LocalHostSession, calls };
}

describe("SnapshotService.create on a remote host (batched)", () => {
  it("captures every repo in ONE remote command without touching the index", async () => {
    const { host: remote, calls } = asRemote(host);
    await write(path.join(a, "staged.txt"), "s\n");
    git(a, ["add", "staged.txt"]);
    await write(path.join(a, "keep.txt"), "changed\n");
    await write(path.join(a, "new.txt"), "untracked\n");
    await write(path.join(a, "ignored.log"), "nope\n");
    await write(path.join(a, "big.bin"), Buffer.alloc(4096, 1));
    const indexBefore = await sha(path.join(a, ".git/index"));
    const statusBefore = git(a, ["status", "--porcelain"]);

    const meta = await svc.create(remote, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    const ra = meta.repos[0]!;
    expect(ra.status).toBe("ok");
    expect(calls.filter((c) => c === "run")).toHaveLength(1);
    expect(calls).not.toContain("stat");
    expect(lsTree(a, ra.commit)).toEqual([".gitignore", "keep.txt", "new.txt", "staged.txt"]);
    expect(ra.largeFiles).toHaveLength(1);
    expect(ra.largeFiles[0]).toMatchObject({ path: "big.bin", size: 4096 });
    expect(git(a, ["rev-parse", `refs/anchor/snapshots/${meta.id}`]).trim()).toBe(ra.commit);
    expect(git(a, ["rev-parse", `${ra.commit}^`]).trim()).toBe(ra.head);
    expect(ra.branch).toBe("main");
    expect(await sha(path.join(a, ".git/index"))).toBe(indexBefore);
    expect(git(a, ["status", "--porcelain"])).toBe(statusBefore);
  });

  it("keeps the cached scratch index correct across snapshots (deletes, growth past the limit)", async () => {
    const { host: remote } = asRemote(host);
    await write(path.join(a, "grow.bin"), "small\n");
    await write(path.join(a, "tmp.txt"), "x\n");
    const s1 = await svc.create(remote, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    expect(lsTree(a, s1.repos[0]!.commit)).toEqual([".gitignore", "grow.bin", "keep.txt", "tmp.txt"]);
    await fs.rm(path.join(a, "tmp.txt"));
    await write(path.join(a, "grow.bin"), Buffer.alloc(4096, 3));
    await write(path.join(a, "keep.txt"), "v2\n");
    const s2 = await svc.create(remote, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    const r2 = s2.repos[0]!;
    expect(lsTree(a, r2.commit)).toEqual([".gitignore", "keep.txt"]);
    expect(git(a, ["show", `${r2.commit}:keep.txt`])).toBe("v2\n");
    expect(r2.largeFiles.map((f) => f.path)).toEqual(["grow.bin"]);
  });

  it("falls back to the external store when a remote pushes refs/*", async () => {
    const { host: remote } = asRemote(host);
    const realHome = process.env.HOME;
    process.env.HOME = ws;
    onTestFinished(() => void (process.env.HOME = realHome));
    git(a, ["remote", "add", "--mirror=push", "bk", path.join(ws, "bk.git")]);
    const meta = await svc.create(remote, { workspaceRoot: ws, repoRoots: [a], source: "manual" });
    expect(meta.repos[0]!.storage).toBe("external");
    expect(git(a, ["for-each-ref", "refs/anchor"])).toBe("");
  });

  it("isolates per-repo failures, streams progress and lists the result back", async () => {
    const { host: remote, calls } = asRemote(host);
    const missing = path.join(ws, "gone");
    await write(path.join(b, "big.bin"), Buffer.alloc(4096, 1));
    const events: SnapshotProgress[] = [];
    const meta = await svc.create(remote, { workspaceRoot: ws, repoRoots: [a, missing, b], source: "manual", name: "批量" }, (p) => events.push(p));
    expect(calls.filter((c) => c === "run")).toHaveLength(1);
    expect(meta.repos.map((r) => r.status)).toEqual(["ok", "error", "ok"]);
    expect(meta.repos[1]!.note).toMatch(/gone|No such file|cannot/i);
    expect(events[0]).toMatchObject({ total: 3, done: 0, failed: 0 });
    expect(events.at(-1)).toMatchObject({ total: 3, done: 3, failed: 1, largeFiles: 1 });
    expect(events.at(-1)!.repos.map((r) => r.state)).toEqual(["ok", "error", "ok"]);
    // done is monotonic and every repo is reported exactly once
    expect(events.map((e) => e.done)).toEqual([...events.map((e) => e.done)].sort((x, y) => x - y));
    const listed = (await svc.list(host, ws, [a, b])).find((s) => s.id === meta.id)!;
    expect(listed.name).toBe("批量");
    expect(listed.repos.find((r) => r.root === b)!.largeFiles).toMatchObject([{ path: "big.bin", size: 4096 }]);
  });
});

describe("remote script helpers", () => {
  it("parses progress lines and framed results", () => {
    expect(parseProgressLines("x\n@@ANCHOR@@ P 2 ok 3\n@@ANCHOR@@ P 0 error 0\n")).toEqual([
      { idx: 2, ok: true, large: 3 },
      { idx: 0, ok: false, large: 0 },
    ]);
    const res = parseRemoteResults('@@ANCHOR@@ P 0 ok 0\n\n@@ANCHOR@@ R 0\nok abc\n{"tree":"t","largeFiles":[]}\n\n@@ANCHOR@@ R 1\nerror\nfatal: boom\n');
    expect(res.get(0)).toMatchObject({ ok: true, commit: "abc", fields: { tree: "t" } });
    expect(res.get(1)).toMatchObject({ ok: false, error: "fatal: boom" });
  });

  it("shell-quotes hostile paths and names in the script", () => {
    const script = buildRemoteScript([{ root: "/w/it's $(rm -rf ~)", ref: "r", storeRel: "s", msgPrefix: "a'b" }], 10, 6);
    expect(script).toContain(`'/w/it'\\''s $(rm -rf ~)'`);
    expect(script).not.toMatch(/\$\\\{/);
  });
});
