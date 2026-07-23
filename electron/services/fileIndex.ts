import type { HostSession } from "../host/types.js";
import { hostJoin } from "../host/paths.js";

/** Directories never walked for Quick Open indexing. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
  ".vscode",
  "Pods",
  "DerivedData",
]);

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 32;
/** Concurrent directory reads for the fallback walk. */
const WALK_CONCURRENCY = 8;

export interface FindFilesResult {
  root: string;
  files: string[];
  truncated: boolean;
  /** How the index was built — useful for UI status. */
  source: "git" | "walk";
}

/**
 * Recursively list file paths relative to `root`.
 * Prefer `git ls-files` (fast, respects ignore); fall back to concurrent listDir walk.
 * Paths always use `/` for stable UI matching across Local/WSL.
 */
export async function findWorkspaceFiles(
  host: HostSession,
  root: string,
  opts?: { maxFiles?: number; maxDepth?: number },
): Promise<FindFilesResult> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;

  const viaGit = await tryGitLsFiles(host, root, maxFiles);
  if (viaGit) return viaGit;

  return walkFiles(host, root, maxFiles, maxDepth);
}

async function tryGitLsFiles(
  host: HostSession,
  root: string,
  maxFiles: number,
): Promise<FindFilesResult | null> {
  try {
    // Cached + untracked, still honor .gitignore
    const r = await host.run(root, "git", [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    if (r.code !== 0) return null;
    const raw = r.stdout;
    if (!raw) {
      // Empty repo still counts as success
      return { root, files: [], truncated: false, source: "git" };
    }
    const files: string[] = [];
    let truncated = false;
    for (const part of raw.split("\0")) {
      if (!part) continue;
      // Skip git links / weird entries that look like dirs (trailing slash)
      if (part.endsWith("/")) continue;
      files.push(part.replace(/\\/g, "/"));
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    files.sort((a, b) => a.localeCompare(b));
    return { root, files, truncated, source: "git" };
  } catch {
    return null;
  }
}

async function walkFiles(
  host: HostSession,
  root: string,
  maxFiles: number,
  maxDepth: number,
): Promise<FindFilesResult> {
  const files: string[] = [];
  let truncated = false;

  type Job = { abs: string; rel: string; depth: number };
  const queue: Job[] = [{ abs: root, rel: "", depth: 0 }];

  async function processOne(job: Job): Promise<void> {
    if (truncated) return;
    if (job.depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await host.listDir(job.abs);
    } catch {
      return;
    }

    // Collect files at this level first (breadth-first preference), then enqueue dirs.
    // Avoids the old DFS “dirs-first” bug that burned maxFiles in one deep tree.
    const dirs: Job[] = [];
    for (const ent of entries) {
      if (truncated) return;
      if (!ent?.name || ent.name === "." || ent.name === ".." || ent.name === ".DS_Store") {
        continue;
      }
      const abs = hostJoin(host.kind, job.abs, ent.name);
      const rel = job.rel ? `${job.rel}/${ent.name}` : ent.name;
      if (ent.type === "dir") {
        if (SKIP_DIR_NAMES.has(ent.name)) continue;
        dirs.push({ abs, rel, depth: job.depth + 1 });
      } else if (ent.type === "file") {
        files.push(rel.replace(/\\/g, "/"));
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
    if (!truncated) {
      for (const d of dirs) queue.push(d);
    }
  }

  while (queue.length > 0 && !truncated) {
    const batch = queue.splice(0, WALK_CONCURRENCY);
    await Promise.all(batch.map((job) => processOne(job)));
  }

  files.sort((a, b) => a.localeCompare(b));
  return { root, files, truncated, source: "walk" };
}
