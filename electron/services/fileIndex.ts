import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
  // Huge third-party trees; still openable via path / content search.
  "external",
]);

const DEFAULT_MAX_FILES = 200_000;
const DEFAULT_MAX_DEPTH = 32;
const WALK_CONCURRENCY = 8;
const GIT_SCAN_DEPTH = 8;
const GIT_LS_CONCURRENCY = 6;
const DISK_CACHE_TTL_MS = 30 * 60_000;

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
 * 2) multi-repo one-shot discover+ls-files (WSL/SSH), with disk cache
 * Fall back to concurrent listDir walk.
 */
export async function findWorkspaceFiles(
  host: HostSession,
  root: string,
  opts?: { maxFiles?: number; maxDepth?: number },
): Promise<FindFilesResult> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const workspace = hostNormalize(host.kind, root);

  const cached = await readDiskCache(host.kind, workspace, maxFiles);
  if (cached) return cached;

  if (await isUsableGitRoot(host, workspace)) {
    const viaGit = await tryGitLsFiles(host, workspace, maxFiles, "", true);
    if (viaGit) {
      await writeDiskCache(host.kind, workspace, maxFiles, viaGit);
      return { ...viaGit, source: "git" };
    }
  }

  if (host.kind === "wsl" || host.kind === "ssh") {
    const oneShot = await multiRepoIndexOneShot(host, workspace, maxFiles);
    if (oneShot && oneShot.files.length > 0) {
      await writeDiskCache(host.kind, workspace, maxFiles, oneShot);
      return oneShot;
    }
  }

  const nested = await discoverNestedGitRoots(host, workspace);
  if (nested.length > 0) {
    const multi = await mergeGitRepos(host, workspace, nested, maxFiles);
    if (multi.files.length > 0) {
      await writeDiskCache(host.kind, workspace, maxFiles, multi);
      return multi;
    }
  }

  const walked = await walkFiles(host, workspace, maxFiles, maxDepth);
  await writeDiskCache(host.kind, workspace, maxFiles, walked);
  return walked;
}

function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "anchor-code", "file-index");
}

function cacheKey(hostKind: string, workspace: string, maxFiles: number): string {
  return createHash("sha1")
    .update(`${hostKind}\0${workspace}\0${maxFiles}\0v3-cached`)
    .digest("hex");
}

async function readDiskCache(
  hostKind: string,
  workspace: string,
  maxFiles: number,
): Promise<FindFilesResult | null> {
  try {
    const file = path.join(
      cacheDir(),
      `${cacheKey(hostKind, workspace, maxFiles)}.json`,
    );
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw) as {
      at: number;
      root: string;
      files: string[];
      truncated: boolean;
      source: FindFilesResult["source"];
    };
    if (!data?.files?.length) return null;
    if (Date.now() - data.at > DISK_CACHE_TTL_MS) return null;
    if (data.root !== workspace) return null;
    return {
      root: data.root,
      files: data.files,
      truncated: Boolean(data.truncated),
      source: data.source || "multi-git",
    };
  } catch {
    return null;
  }
}

async function writeDiskCache(
  hostKind: string,
  workspace: string,
  maxFiles: number,
  result: FindFilesResult,
): Promise<void> {
  try {
    if (result.files.length === 0) return;
    const dir = cacheDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      `${cacheKey(hostKind, workspace, maxFiles)}.json`,
    );
    await fs.writeFile(
      file,
      JSON.stringify({
        at: Date.now(),
        root: workspace,
        files: result.files,
        truncated: result.truncated,
        source: result.source,
      }),
    );
  } catch {
    // best-effort
  }
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
 * One WSL/SSH process: find nested .git roots + git ls-files --cached.
 * Skips untracked (big win) and prunes external/.
 */
async function multiRepoIndexOneShot(
  host: HostSession,
  workspaceRoot: string,
  maxFiles: number,
): Promise<FindFilesResult | null> {
  const maxdepth = String(GIT_SCAN_DEPTH + 1);
  const rootQ = workspaceRoot.replace(/'/g, `'\\''`);
  const pruneNames = [...SKIP_DIR_NAMES].filter((d) => d !== ".git");
  const pruneExpr = pruneNames.map((d) => `-name ${d}`).join(" -o ");
  const script = [
    `ws='${rootQ}'`,
    `maxdepth=${maxdepth}`,
    `roots=$(find "$ws" -maxdepth $maxdepth \\( ${pruneExpr} \\) -prune -o -name .git -print 2>/dev/null | while IFS= read -r g; do`,
    `  d=$(dirname "$g")`,
    `  case "$d" in */.repo|*/.repo/*) continue ;; esac`,
    `  if [ -f "$g/HEAD" ] || [ -f "$g" ]; then printf '%s\\n' "$d"; fi`,
    `done)`,
    `while IFS= read -r root; do`,
    `  [ -z "$root" ] && continue`,
    `  if [ "$root" = "$ws" ]; then pref=''; else pref="\${root#\$ws/}/"; fi`,
    `  printf '__P__%s\\n' "$pref"`,
    `  git -C "$root" ls-files --cached 2>/dev/null || true`,
    `done <<EOF`,
    `$roots`,
    `EOF`,
  ].join("\n");

  try {
    const t0 = Date.now();
    const result = await host.run(workspaceRoot, "bash", ["-s"], {
      stdin: script,
      timeoutMs: 90_000,
    });
    if (!result.stdout && result.code !== 0) return null;
    const parsed = parsePrefixedLsFiles(result.stdout, workspaceRoot, maxFiles);
    console.log(
      `[fileIndex] one-shot multi-git ${parsed.files.length} files in ${Date.now() - t0}ms`,
    );
    return parsed;
  } catch (err) {
    console.warn("[fileIndex] one-shot multi-git failed:", err);
    return null;
  }
}

function parsePrefixedLsFiles(
  stdout: string,
  workspaceRoot: string,
  maxFiles: number,
): FindFilesResult {
  const files: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let prefix = "";
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    if (line.startsWith("__P__")) {
      // Marker is 5 chars: __P__  (slice(4) wrongly kept a leading _)
      prefix = line.slice("__P__".length);
      continue;
    }
    if (line.endsWith("/")) continue;
    if (/\.(o|a|so|dylib|dll|bin|elf|obj|pyc|pyo|class)$/i.test(line)) continue;
    if (/(^|\/)(output|output\.\d+|out|build|dist)(\/|$)/i.test(line)) continue;
    const rel = `${prefix}${line}`.replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return {
    root: workspaceRoot,
    files: truncated ? files.slice(0, maxFiles) : files,
    truncated,
    source: "multi-git",
  };
}

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
      if (/(^|\/)\.repo(\/|$)/.test(p)) continue;
      if (
        hostNormalize(host.kind, p) === hostNormalize(host.kind, workspaceRoot)
      ) {
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
      if (e.name.startsWith(".") && e.name !== ".git") continue;
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
  pathPrefix: string,
  includeUntracked: boolean,
): Promise<FindFilesResult | null> {
  try {
    const args = includeUntracked
      ? ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
      : ["ls-files", "-z", "--cached"];
    const r = await host.run(repoRoot, "git", args);
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
  const ordered = [...repoRoots].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );

  if ((host.kind === "wsl" || host.kind === "ssh") && ordered.length > 1) {
    const bulk = await bulkGitLsFiles(host, workspaceRoot, ordered, maxFiles);
    if (bulk) return bulk;
  }

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
      const one = await tryGitLsFiles(host, absRoot, maxFiles, prefix, false);
      perRepo[idx] = one?.files ?? [];
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          host.kind === "local" ? GIT_LS_CONCURRENCY : 2,
          Math.max(ordered.length, 1),
        ),
      },
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

async function bulkGitLsFiles(
  host: HostSession,
  workspaceRoot: string,
  orderedRoots: string[],
  maxFiles: number,
): Promise<FindFilesResult | null> {
  const rootsLit = orderedRoots
    .map((r) => `'${r.replace(/'/g, `'\\''`)}'`)
    .join(" ");
  const workspaceQ = workspaceRoot.replace(/'/g, `'\\''`);
  const script = [
    `ws='${workspaceQ}'`,
    `for root in ${rootsLit}; do`,
    `  if [ "$root" = "$ws" ]; then pref=''; else pref="\${root#\$ws/}/"; fi`,
    `  printf '__P__%s\\n' "$pref"`,
    `  git -C "$root" ls-files --cached 2>/dev/null || true`,
    `done`,
  ].join("\n");

  try {
    const result = await host.run(workspaceRoot, "bash", ["-s"], {
      stdin: script,
      timeoutMs: Math.max(60_000, orderedRoots.length * 400),
    });
    if (!result.stdout && result.code !== 0) return null;
    return parsePrefixedLsFiles(result.stdout, workspaceRoot, maxFiles);
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
