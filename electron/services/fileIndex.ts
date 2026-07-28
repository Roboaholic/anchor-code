import type { HostSession } from "../host/types.js";
import {
  hostBasename,
  hostJoin,
  hostNormalize,
} from "../host/paths.js";

/** Directories never walked for Quick Open indexing. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "output",
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
  ".repo",
  ".worktrees",
  ".ci-analysis",
  ".ci_analysis",
  ".ci_failure_analysis",
]);

const DEFAULT_MAX_FILES = 300_000;
const DEFAULT_MAX_DEPTH = 32;
/** Concurrent directory reads for the fallback walk. */
const WALK_CONCURRENCY = 8;
/** Nested git discovery depth (repo layouts need ~6–8). */
const GIT_SCAN_DEPTH = 8;
/** Cap concurrent git ls-files (WSL). */
const GIT_LS_CONCURRENCY = 6;

export interface FindFilesResult {
  root: string;
  files: string[];
  truncated: boolean;
  source: "git" | "walk" | "multi-git";
}

/**
 * Recursively list file paths relative to `root`.
 *
 * Prefer git:
 * 1) single-repo `git ls-files` when workspace root is a valid git worktree
 * 2) multi-repo: discover nested git roots (Android `repo` style) and merge
 *    each repo's `git ls-files` with a path prefix
 * Fall back to concurrent listDir walk.
 *
 * Paths always use `/` for stable UI matching across Local/WSL.
 */
export async function findWorkspaceFiles(
  host: HostSession,
  root: string,
  opts?: { maxFiles?: number; maxDepth?: number },
): Promise<FindFilesResult> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const workspace = hostNormalize(host.kind, root);

  // 1) Workspace root is a real git worktree → single ls-files.
  if (await isUsableGitRoot(host, workspace)) {
    const viaGit = await tryGitLsFiles(host, workspace, maxFiles, "");
    if (viaGit && viaGit.files.length > 0) {
      return { ...viaGit, source: "git" };
    }
    // Empty but valid repo: still better than a huge walk of ignored trees.
    if (viaGit) return { ...viaGit, source: "git" };
  }

  // 2) Multi-repo workspace (repo tool / monorepo with nested checkouts).
  const nested = await discoverNestedGitRoots(host, workspace);
  if (nested.length > 0) {
    const multi = await mergeGitRepos(host, workspace, nested, maxFiles);
    if (multi.files.length > 0) return multi;
  }

  // 3) Fallback walk.
  return walkFiles(host, workspace, maxFiles, maxDepth);
}

async function isUsableGitRoot(
  host: HostSession,
  dir: string,
): Promise<boolean> {
  const gitPath = hostJoin(host.kind, dir, ".git");
  try {
    const st = await host.stat(gitPath);
    if (st.isFile) return true;
    if (!st.isDir) return false;
    await host.stat(hostJoin(host.kind, gitPath, "HEAD"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover nested git worktrees under workspace.
 * WSL/SSH: one `find` via bash -s (handles symlink `.git` used by `repo`).
 * Local: bounded walk.
 */
async function discoverNestedGitRoots(
  host: HostSession,
  workspaceRoot: string,
): Promise<string[]> {
  if (host.kind === "wsl" || host.kind === "ssh") {
    const viaFind = await discoverGitRootsViaFind(host, workspaceRoot);
    if (viaFind) return viaFind;
  }
  return walkDiscoverGitRoots(host, workspaceRoot);
}

async function discoverGitRootsViaFind(
  host: HostSession,
  workspaceRoot: string,
): Promise<string[] | null> {
  const maxdepth = String(GIT_SCAN_DEPTH + 1);
  const rootQ = workspaceRoot.replace(/'/g, `'\\''`);
  const pruneNames = [...SKIP_DIR_NAMES].filter((d) => d !== ".git");
  const pruneExpr = pruneNames.map((d) => `-name ${d}`).join(" -o ");
  // -L: follow directory symlinks only when resolving; still print .git path.
  // Validate HEAD after following symlink `.git` → .repo/projects/….git
  const script = [
    `root='${rootQ}'`,
    `find "$root" -maxdepth ${maxdepth} \\( ${pruneExpr} \\) -prune -o -name .git -print 2>/dev/null | while IFS= read -r g; do`,
    `  d=$(dirname "$g")`,
    `  if [ -f "$g/HEAD" ] || [ -f "$g" ]; then echo "$d"; fi`,
    `done`,
  ].join("\n");

  try {
    const result = await host.run(workspaceRoot, "bash", ["-s"], {
      stdin: script,
      timeoutMs: 60_000,
    });
    if (!result.stdout.trim() && result.code !== 0) return null;
    const roots: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const p = line.trim().replace(/\\/g, "/");
      if (!p) continue;
      // Skip .repo internals and empty workspace stubs.
      if (/(^|\/)\.repo(\/|$)/.test(p)) continue;
      if (hostNormalize(host.kind, p) === hostNormalize(host.kind, workspaceRoot)) {
        // Only keep if usable (caller may already know root is empty stub).
        if (!(await isUsableGitRoot(host, p))) continue;
      }
      roots.push(hostNormalize(host.kind, p));
    }
    return [...new Set(roots)];
  } catch {
    return null;
  }
}

async function walkDiscoverGitRoots(
  host: HostSession,
  workspaceRoot: string,
): Promise<string[]> {
  const roots: string[] = [];
  type Job = { dir: string; depth: number };
  const queue: Job[] = [{ dir: workspaceRoot, depth: 1 }];

  async function processOne(job: Job): Promise<void> {
    if (job.depth > GIT_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await host.listDir(job.dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.type !== "dir") continue;
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".git") {
        // allow nothing else under dot-dirs for index discovery
        continue;
      }
      const child = hostJoin(host.kind, job.dir, e.name);
      if (await isUsableGitRoot(host, child)) {
        roots.push(hostNormalize(host.kind, child));
        continue;
      }
      queue.push({ dir: child, depth: job.depth + 1 });
    }
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, WALK_CONCURRENCY);
    await Promise.all(batch.map((j) => processOne(j)));
  }
  return roots;
}

function toWorkspaceRelative(
  hostKind: HostSession["kind"],
  workspaceRoot: string,
  absPath: string,
): string {
  // Always compare with `/` so Windows local path.resolve() output works.
  const w = hostNormalize(hostKind, workspaceRoot)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const a = hostNormalize(hostKind, absPath).replace(/\\/g, "/");
  if (a === w) return "";
  if (a.startsWith(w + "/")) return a.slice(w.length + 1);
  return hostBasename(hostKind, absPath);
}

async function tryGitLsFiles(
  host: HostSession,
  repoRoot: string,
  maxFiles: number,
  /** Prefix under workspace (no trailing slash), empty for workspace-root repo. */
  pathPrefix: string,
): Promise<FindFilesResult | null> {
  try {
    const r = await host.run(repoRoot, "git", [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    if (r.code !== 0) return null;
    const raw = r.stdout;
    if (!raw) {
      return { root: repoRoot, files: [], truncated: false, source: "git" };
    }
    const files: string[] = [];
    let truncated = false;
    for (const part of raw.split("\0")) {
      if (!part) continue;
      if (part.endsWith("/")) continue;
      const rel = part.replace(/\\/g, "/");
      // Skip heavy generated/object noise even if tracked.
      if (/\.(o|a|so|dylib|dll|bin|elf|obj|pyc|pyo|class)$/i.test(rel)) continue;
      if (/(^|\/)(output|output\.\d+|out|build|dist)\//i.test(rel)) continue;
      const full = pathPrefix ? `${pathPrefix}/${rel}` : rel;
      files.push(full);
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    files.sort((a, b) => a.localeCompare(b));
    return { root: repoRoot, files, truncated, source: "git" };
  } catch {
    return null;
  }
}

async function mergeGitRepos(
  host: HostSession,
  workspaceRoot: string,
  repoRoots: string[],
  maxFiles: number,
): Promise<FindFilesResult> {
  // Stable order: shorter roots first (parents), then path.
  const ordered = [...repoRoots].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
  const perRepo: string[][] = new Array(ordered.length);
  let i = 0;

  async function worker() {
    while (i < ordered.length) {
      const idx = i++;
      const absRoot = ordered[idx]!;
      const prefix = toWorkspaceRelative(host.kind, workspaceRoot, absRoot);
      if (!(await isUsableGitRoot(host, absRoot))) {
        perRepo[idx] = [];
        continue;
      }
      // No per-repo room cap — collect full then truncate once at the end so
      // concurrent workers don't race which repo's files get dropped.
      const one = await tryGitLsFiles(host, absRoot, maxFiles, prefix);
      perRepo[idx] = one?.files ?? [];
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(GIT_LS_CONCURRENCY, Math.max(ordered.length, 1)) },
      () => worker(),
    ),
  );

  const files: string[] = [];
  const seen = new Set<string>();
  for (const batch of perRepo) {
    if (!batch) continue;
    for (const f of batch) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  const truncated = files.length > maxFiles;
  return {
    root: workspaceRoot,
    files: truncated ? files.slice(0, maxFiles) : files,
    truncated,
    source: "multi-git",
  };
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
      if (
        !ent?.name ||
        ent.name === "." ||
        ent.name === ".." ||
        ent.name === ".DS_Store"
      ) {
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
