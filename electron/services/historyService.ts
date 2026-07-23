import {
  formatCompareTitle,
  parseNameStatus,
  type DiffFile,
} from "../../src/core/history/diffParse.js";
import {
  parsePorcelainStatus,
  type StatusEntry,
} from "../../src/core/history/statusParse.js";
import type { HostSession } from "../host/types.js";
import {
  hostBasename,
  hostDirname,
  hostJoin,
  hostNormalize,
} from "../host/paths.js";
import { HostError } from "../host/types.js";

const LOG_LIMIT = 200;
/** Nested .git under workspace. Path like hardware/ambarella/cv5/repo needs ≥4. */
const SCAN_DEPTH = 6;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);
const WALK_CONCURRENCY = 6;

export interface RepoInfo {
  root: string;
  name: string;
}

export interface CommitRow {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  dateIso: string;
}

export type { DiffFile, StatusEntry };

export interface DiffOpenPayload {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  title: string;
  files: DiffFile[];
  branch?: string | null;
}

export interface FileDiffContent {
  path: string;
  oldText: string;
  newText: string;
  status: string;
}

export interface RepoStatus {
  repoRoot: string;
  entries: StatusEntry[];
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

async function isGitRoot(host: HostSession, dir: string): Promise<boolean> {
  const gitPath = hostJoin(host.kind, dir, ".git");
  if (!(await host.exists(gitPath))) return false;
  try {
    const st = await host.stat(gitPath);
    return st.isDir || st.isFile;
  } catch {
    return false;
  }
}

async function discoverViaFind(
  host: HostSession,
  workspaceRoot: string,
): Promise<string[] | null> {
  if (host.kind !== "wsl" && host.kind !== "ssh") return null;

  // One bash -lc script: avoids argv edge cases and is ~50ms warm / cold-start bound.
  const maxdepth = String(SCAN_DEPTH + 1);
  const rootQ = workspaceRoot.replace(/'/g, `'\\''`);
  const script = [
    `find '${rootQ}' -maxdepth ${maxdepth}`,
    `\\( -name node_modules -o -name dist -o -name build -o -name out -o -name .next -o -name target -o -name .cache -o -name .turbo -o -name coverage -o -name __pycache__ -o -name .venv -o -name venv \\)`,
    `-prune -o -name .git -print 2>/dev/null`,
  ].join(" ");

  const result = await host.run(workspaceRoot, "bash", ["-lc", script]);
  // find often exits 0; treat empty+error as failure so caller can decide
  if (!result.stdout.trim() && result.code !== 0) {
    return null;
  }

  const roots: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const p = line.trim().replace(/\\/g, "/");
    if (!p) continue;
    if (p.endsWith("/.git") || /\/\.git$/.test(p) || p === ".git") {
      const repo = p === ".git" ? workspaceRoot : hostDirname(host.kind, p);
      if (repo) roots.push(repo);
    }
  }
  return roots;
}

async function walkDiscover(
  host: HostSession,
  workspaceRoot: string,
): Promise<string[]> {
  const roots: string[] = [];
  if (await isGitRoot(host, workspaceRoot)) {
    roots.push(workspaceRoot);
  }

  type Job = { dir: string; depth: number };
  const queue: Job[] = [{ dir: workspaceRoot, depth: 1 }];

  async function processOne(job: Job): Promise<void> {
    if (job.depth > SCAN_DEPTH) return;
    let entries;
    try {
      entries = await host.listDir(job.dir);
    } catch {
      return;
    }
    const subdirs: Job[] = [];
    for (const e of entries) {
      if (e.type !== "dir") continue;
      if (
        SKIP_DIRS.has(e.name) ||
        (e.name.startsWith(".") && e.name !== ".git")
      ) {
        continue;
      }
      const child = hostJoin(host.kind, job.dir, e.name);
      if (await isGitRoot(host, child)) {
        roots.push(child);
        continue;
      }
      subdirs.push({ dir: child, depth: job.depth + 1 });
    }
    for (const s of subdirs) queue.push(s);
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, WALK_CONCURRENCY);
    await Promise.all(batch.map((j) => processOne(j)));
  }

  return roots;
}

export async function discoverRepos(
  host: HostSession,
  workspaceRoot: string,
): Promise<RepoInfo[]> {
  const root = hostNormalize(host.kind, workspaceRoot);

  // Always try to include workspace root if it is itself a git repo (instant).
  const roots: string[] = [];
  try {
    if (await isGitRoot(host, root)) roots.push(root);
  } catch {
    // ignore
  }

  let nested: string[] | null = null;
  try {
    nested = await discoverViaFind(host, root);
  } catch {
    nested = null;
  }

  // Local only: recursive listDir walk. Never on WSL/SSH (too many UNC/stat round-trips).
  if (nested === null && host.kind === "local") {
    nested = await walkDiscover(host, root);
  }

  if (nested) {
    for (const r of nested) roots.push(r);
  }

  // If find failed on WSL but workspace root is git, still return at least that.
  const unique = [...new Set(roots.map((r) => hostNormalize(host.kind, r)))];
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b));

  return unique.map((repoRoot) => ({
    root: repoRoot,
    name: hostBasename(host.kind, repoRoot) || repoRoot,
  }));
}

export async function loadLog(
  host: HostSession,
  repoRoot: string,
): Promise<CommitRow[]> {
  const result = await host.run(repoRoot, "git", [
    "log",
    "--date-order",
    `-n${LOG_LIMIT}`,
    "--format=%H%x09%h%x09%s%x09%an%x09%aI",
  ]);
  if (result.code !== 0) {
    throw new HostError(
      "failed",
      "Failed to load git log",
      result.stderr || result.stdout,
    );
  }
  const lines = result.stdout.split("\n").filter(Boolean);
  return lines.map((line) => {
    const [hash, shortHash, subject, author, dateIso] = line.split("\t");
    return {
      hash: hash ?? "",
      shortHash: shortHash ?? "",
      subject: subject ?? "",
      author: author ?? "",
      dateIso: dateIso ?? "",
    };
  });
}

export async function loadRepoStatus(
  host: HostSession,
  repoRoot: string,
): Promise<RepoStatus> {
  const result = await host.run(repoRoot, "git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (result.code !== 0 && !result.stdout) {
    throw new HostError(
      "failed",
      "Failed to load git status",
      result.stderr || result.stdout,
    );
  }
  const entries = parsePorcelainStatus(result.stdout);
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;
  for (const e of entries) {
    if (e.status === "M" || e.status === "R" || e.status === "C") modified += 1;
    else if (e.status === "A") added += 1;
    else if (e.status === "D") deleted += 1;
    else if (e.status === "?") untracked += 1;
  }
  return { repoRoot, entries, modified, added, deleted, untracked };
}

async function resolveBranch(
  host: HostSession,
  repoRoot: string,
): Promise<string | null> {
  try {
    const r = await host.run(repoRoot, "git", [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (r.code !== 0) return null;
    const b = r.stdout.trim();
    if (!b || b === "HEAD") return null;
    return b;
  } catch {
    return null;
  }
}

function short(hash: string): string {
  if (hash === "HEAD" || hash === "worktree") return hash;
  return hash.slice(0, 7);
}

function mergeDiffFiles(...lists: DiffFile[][]): DiffFile[] {
  const map = new Map<string, DiffFile>();
  for (const list of lists) {
    for (const f of list) {
      if (!f.path) continue;
      const prev = map.get(f.path);
      if (!prev) {
        map.set(f.path, f);
        continue;
      }
      if (prev.status === "?" && f.status !== "?") {
        map.set(f.path, f);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function untrackedAsAdded(
  host: HostSession,
  repoRoot: string,
): Promise<DiffFile[]> {
  const st = await loadRepoStatus(host, repoRoot);
  return st.entries
    .filter((e) => e.status === "?")
    .map((e) => ({ path: e.path, status: "?" }));
}

export async function compareCommits(
  host: HostSession,
  repoRoot: string,
  base: string,
  head: string,
): Promise<DiffOpenPayload> {
  const result = await host.run(repoRoot, "git", [
    "diff",
    "--name-status",
    base,
    head,
  ]);
  if (result.code !== 0 && !result.stdout) {
    throw new HostError(
      "failed",
      "git diff failed",
      result.stderr || result.stdout,
    );
  }
  const files = parseNameStatus(result.stdout);
  const branch = await resolveBranch(host, repoRoot);
  return {
    repoRoot,
    base,
    head,
    title: formatCompareTitle(short(base), head, short(head)),
    files,
    branch,
  };
}

/**
 * Compare a base revision (commit or HEAD) to the worktree.
 * Includes tracked changes AND untracked files.
 */
export async function compareToWorktree(
  host: HostSession,
  repoRoot: string,
  base: string,
): Promise<DiffOpenPayload> {
  const result = await host.run(repoRoot, "git", [
    "diff",
    "--name-status",
    base,
  ]);
  if (result.code !== 0 && !result.stdout) {
    throw new HostError(
      "failed",
      "git diff (worktree) failed",
      result.stderr || result.stdout,
    );
  }
  const tracked = parseNameStatus(result.stdout);
  const untracked = await untrackedAsAdded(host, repoRoot);
  const files = mergeDiffFiles(tracked, untracked);
  const branch = await resolveBranch(host, repoRoot);
  return {
    repoRoot,
    base,
    head: "worktree",
    title: formatCompareTitle(short(base), "worktree"),
    files,
    branch,
  };
}

async function gitShow(
  host: HostSession,
  repoRoot: string,
  revPath: string,
): Promise<string> {
  const result = await host.run(repoRoot, "git", ["show", revPath]);
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

export async function getFileDiff(
  host: HostSession,
  repoRoot: string,
  base: string,
  head: string | "worktree",
  filePath: string,
  status: string,
): Promise<FileDiffContent> {
  let oldText = "";
  let newText = "";

  if (status === "?" || status.startsWith("A") || status === "A") {
    oldText = "";
  } else {
    oldText = await gitShow(host, repoRoot, `${base}:${filePath}`);
  }

  if (status.startsWith("D") || status === "D") {
    newText = "";
  } else if (head === "worktree") {
    const abs = hostJoin(host.kind, repoRoot, filePath);
    if (await host.exists(abs)) {
      try {
        newText = await host.readFile(abs);
      } catch {
        newText = "";
      }
    }
  } else {
    newText = await gitShow(host, repoRoot, `${head}:${filePath}`);
  }

  return { path: filePath, oldText, newText, status };
}
