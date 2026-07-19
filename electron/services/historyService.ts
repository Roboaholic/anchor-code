import path from "node:path";
import {
  formatCompareTitle,
  parseNameStatus,
  type DiffFile,
} from "../../src/core/history/diffParse.js";
import type { LocalHostSession } from "../host/localHost.js";
import { HostError } from "../host/types.js";

const LOG_LIMIT = 200;
const SCAN_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target"]);

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

export type { DiffFile };

export interface DiffOpenPayload {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  title: string;
  files: DiffFile[];
}

export interface FileDiffContent {
  path: string;
  oldText: string;
  newText: string;
  status: string;
}

async function isGitRoot(host: LocalHostSession, dir: string): Promise<boolean> {
  const gitPath = path.join(dir, ".git");
  if (!(await host.exists(gitPath))) return false;
  try {
    const st = await host.stat(gitPath);
    return st.isDir || st.isFile;
  } catch {
    return false;
  }
}

async function walkForGitRoots(
  host: LocalHostSession,
  dir: string,
  depth: number,
  maxDepth: number,
  out: string[],
): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await host.listDir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.type !== "dir") continue;
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) {
      // still allow checking if this workspace root itself is git (handled outside)
      if (e.name !== ".git") continue;
    }
    const child = path.join(dir, e.name);
    if (await isGitRoot(host, child)) {
      out.push(child);
      // do not descend into nested repos
      continue;
    }
    await walkForGitRoots(host, child, depth + 1, maxDepth, out);
  }
}

export async function discoverRepos(
  host: LocalHostSession,
  workspaceRoot: string,
): Promise<RepoInfo[]> {
  const roots: string[] = [];
  if (await isGitRoot(host, workspaceRoot)) {
    roots.push(workspaceRoot);
  }
  await walkForGitRoots(host, workspaceRoot, 1, SCAN_DEPTH, roots);
  const unique = [...new Set(roots.map((r) => path.resolve(r)))];
  return unique.map((root) => ({
    root,
    name: path.basename(root) || root,
  }));
}

export async function loadLog(
  host: LocalHostSession,
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

function short(hash: string): string {
  return hash.slice(0, 7);
}

export async function compareCommits(
  host: LocalHostSession,
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
  return {
    repoRoot,
    base,
    head,
    title: formatCompareTitle(short(base), head, short(head)),
    files,
  };
}

export async function compareToWorktree(
  host: LocalHostSession,
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
  const files = parseNameStatus(result.stdout);
  return {
    repoRoot,
    base,
    head: "worktree",
    title: formatCompareTitle(short(base), "worktree"),
    files,
  };
}

async function gitShow(
  host: LocalHostSession,
  repoRoot: string,
  revPath: string,
): Promise<string> {
  const result = await host.run(repoRoot, "git", ["show", revPath]);
  if (result.code !== 0) {
    // deleted / missing
    return "";
  }
  return result.stdout;
}

export async function getFileDiff(
  host: LocalHostSession,
  repoRoot: string,
  base: string,
  head: string | "worktree",
  filePath: string,
  status: string,
): Promise<FileDiffContent> {
  let oldText = "";
  let newText = "";

  if (status.startsWith("A") || status === "A") {
    oldText = "";
  } else {
    oldText = await gitShow(host, repoRoot, `${base}:${filePath}`);
  }

  if (status.startsWith("D") || status === "D") {
    newText = "";
  } else if (head === "worktree") {
    const abs = path.join(repoRoot, filePath);
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
