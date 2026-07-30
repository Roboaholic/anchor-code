import {
  formatCompareTitle,
  parseNameStatus,
  type DiffFile,
} from "../../src/core/history/diffParse.js";
import {
  parsePorcelainStatusDetailed,
  type StatusEntry,
} from "../../src/core/history/statusParse.js";
import type { HostSession } from "../host/types.js";
import {
  hostBasename,
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
  ".repo",
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

export interface BlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  dateIso: string;
  subject: string;
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
  /** Current branch name from `git status -b`; null if detached. */
  branch: string | null;
  /** Commits ahead of comparison base; null if no base. */
  ahead: number | null;
  /** Commits behind comparison base; null if no base. */
  behind: number | null;
}

export interface BranchInfo {
  name: string;
  current: boolean;
}

export interface CheckoutResult {
  branch: string;
}

export interface CommitResult {
  hash: string;
  shortHash: string;
  subject: string;
}
async function isGitRoot(host: HostSession, dir: string): Promise<boolean> {
  const gitPath = hostJoin(host.kind, dir, ".git");
  let st: StatLike;
  try {
    // Single stat instead of exists()+stat() — halves fs round-trips.
    st = await host.stat(gitPath);
  } catch {
    return false;
  }
  // Worktree/gitfile: `.git` is a file pointing at the real git dir.
  if (st.isFile) return true;
  if (!st.isDir) return false;
  // Empty or stub `.git` directories are not usable (common in broken checkouts).
  try {
    await host.stat(hostJoin(host.kind, gitPath, "HEAD"));
    return true;
  } catch {
    return false;
  }
}

type StatLike = { isFile: boolean; isDir: boolean };

async function discoverViaFind(
  host: HostSession,
  workspaceRoot: string,
): Promise<string[] | null> {
  if (host.kind !== "wsl" && host.kind !== "ssh") return null;

  // One bash invocation that both walks AND validates git roots, so we never do
  // per-candidate UNC round-trips from Node (each ~1s on WSL via wsl.exe
  // fallback, and UNC can't follow symlink `.git` used by `repo` manifests).
  //
  // Why stdin / `bash -s`: host.run routes args through posixShellCommand into
  // `bash -lc '<script>'`, whose double-shell quoting mangles `'`, `;`, `()`,
  // `$var`, and `{} -exec`. Piping the script on stdin to `bash -s` bypasses
  // that layer entirely, so we can use `\( ... \)`, `while read`, `dirname`,
  // and `[ -f "$g/HEAD" ]` reliably.
  const maxdepth = String(SCAN_DEPTH + 1);
  const rootQ = workspaceRoot.replace(/'/g, `'\\''`);
  const pruneNames = [...SKIP_DIRS].filter((d) => d !== ".git");
  const pruneExpr = pruneNames.map((d) => `-name ${d}`).join(" -o ");
  const script = [
    `root='${rootQ}'`,
    `find "$root" -maxdepth ${maxdepth} \\( ${pruneExpr} \\) -prune -o -name .git -print 2>/dev/null | while IFS= read -r g; do`,
    `  d=$(dirname "$g")`,
    // Valid when: real `.git/HEAD` (normal repo or repo-manifest symlink that
    // resolves to a dir with HEAD), or `.git` is a gitfile (worktree/submodule).
    `  if [ -f "$g/HEAD" ] || [ -f "$g" ]; then echo "$d"; fi`,
    `done`,
  ].join("\n");

  const result = await host.run(workspaceRoot, "bash", ["-s"], { stdin: script });
  // find often exits 0; treat empty+error as failure so caller can decide
  if (!result.stdout.trim() && result.code !== 0) {
    return null;
  }

  const roots: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const p = line.trim().replace(/\\/g, "/");
    if (!p) continue;
    roots.push(hostNormalize(host.kind, p));
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
    for (const r of nested) {
      // discoverViaFind (WSL/SSH) already validated HEAD and stripped stubs;
      // walkDiscover (local) validated inline too. Only re-check the workspace
      // root above goes through isGitRoot. Here we just drop .repo noise and
      // trust the discovery pass — re-validating on WSL would re-introduce the
      // per-root wsl.exe fallback that made discover time out (>20s) on trees
      // with symlink `.git` (e.g. `repo` manifests).
      if (/(^|\/)\.repo(\/|$)/.test(hostNormalize(host.kind, r))) continue;
      roots.push(r);
    }
  }

  const unique = [
    ...new Set(roots.map((r) => hostNormalize(host.kind, r))),
  ];
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

/** Load commit attribution for a tracked file at worktree or a revision. */
export async function loadFileBlame(
  host: HostSession,
  repoRoot: string,
  filePath: string,
  revision?: string,
): Promise<BlameLine[]> {
  const root = hostNormalize(host.kind, repoRoot);
  const normalizedFile = hostNormalize(host.kind, filePath);
  const rootPrefix = root.endsWith("/") || root.endsWith("\\") ? root : `${root}/`;
  const normalizedPrefix = rootPrefix.replace(/\\/g, "/");
  const normalizedForCompare = normalizedFile.replace(/\\/g, "/");
  if (!normalizedForCompare.startsWith(normalizedPrefix)) return [];
  const relativePath = normalizedForCompare.slice(normalizedPrefix.length);
  if (!relativePath) return [];

  const args = ["blame", "--line-porcelain"];
  if (revision?.trim() && revision !== "worktree") args.push(revision.trim());
  args.push("--", relativePath);
  const result = await host.run(root, "git", args);
  if (result.code !== 0) return [];
  return parseBlamePorcelain(result.stdout);
}

export function parseBlamePorcelain(output: string): BlameLine[] {
  const entries: BlameLine[] = [];
  const lines = output.split(/\r?\n/);
  let current: Partial<BlameLine> | null = null;

  for (const line of lines) {
    const header = /^([0-9a-f^]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      const hash = header[1]!.replace(/^\^/, "");
      current = {
        line: Number(header[2]),
        hash,
        shortHash: /^0+$/.test(hash) ? "working" : hash.slice(0, 8),
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("author ")) current.author = line.slice(7);
    else if (line.startsWith("author-time ")) {
      const seconds = Number(line.slice(12));
      if (Number.isFinite(seconds)) current.dateIso = new Date(seconds * 1000).toISOString();
    } else if (line.startsWith("summary ")) current.subject = line.slice(8);
    else if (line.startsWith("\t")) {
      entries.push({
        line: current.line ?? entries.length + 1,
        hash: current.hash ?? "",
        shortHash: current.shortHash ?? "",
        author: current.author ?? "Unknown",
        dateIso: current.dateIso ?? "",
        subject: current.subject ?? "",
      });
      current = null;
    }
  }
  return entries;
}

export async function loadRepoStatus(
  host: HostSession,
  repoRoot: string,
  opts?: { badgeOnly?: boolean; timeoutMs?: number },
): Promise<RepoStatus> {
  // badgeOnly: skip untracked walk (huge SDK trees). Full list when expanding Changes.
  // `-b` adds `## branch...upstream [ahead N, behind M]` so we get tracking in one call.
  const badgeOnly = opts?.badgeOnly === true;
  const result = await host.run(
    repoRoot,
    "git",
    [
      "status",
      "--porcelain",
      "-b",
      badgeOnly ? "--untracked-files=no" : "--untracked-files=normal",
    ],
    { timeoutMs: opts?.timeoutMs ?? (badgeOnly ? 12_000 : 30_000) },
  );
  if (result.code !== 0 && !result.stdout) {
    throw new HostError(
      "failed",
      "Failed to load git status",
      result.stderr || result.stdout,
    );
  }
  const { entries, tracking } = parsePorcelainStatusDetailed(result.stdout);
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
  return {
    repoRoot,
    entries,
    modified,
    added,
    deleted,
    untracked,
    branch: tracking.branch,
    ahead: tracking.ahead,
    behind: tracking.behind,
  };
}

/**
 * Badge-only status for many repos in one host process.
 * Critical on WSL: N parallel `wsl.exe` invocations hang/timeout; one bash
 * loop over roots is ~1s for 50+ repos.
 *
 * When `onStatus` is provided, each finished repo is reported as soon as its
 * block ends (progressive UI dots clear per-repo).
 */
export async function loadRepoStatusesBulk(
  host: HostSession,
  repoRoots: string[],
  opts?: {
    badgeOnly?: boolean;
    timeoutMs?: number;
    onStatus?: (status: RepoStatus) => void;
  },
): Promise<RepoStatus[]> {
  const roots = [
    ...new Set(
      repoRoots
        .map((r) => hostNormalize(host.kind, r))
        .filter(Boolean),
    ),
  ];
  if (roots.length === 0) return [];
  const badgeOnly = opts?.badgeOnly !== false;
  const untracked = badgeOnly ? "no" : "normal";
  const collected: RepoStatus[] = [];
  const seen = new Set<string>();

  const emit = (st: RepoStatus) => {
    if (seen.has(st.repoRoot)) return;
    seen.add(st.repoRoot);
    collected.push(st);
    try {
      opts?.onStatus?.(st);
    } catch {
      // ignore listener errors
    }
  };

  // WSL/SSH: one bash process with progressive stdout parsing.
  if (host.kind === "wsl" || host.kind === "ssh") {
    const rootsLit = roots
      .map((r) => `'${r.replace(/'/g, `'\\''`)}'`)
      .join(" ");
    const script = [
      `untracked='${untracked}'`,
      `for root in ${rootsLit}; do`,
      `  printf '__AC_BEGIN__\\t%s\\n' "$root"`,
      `  if ! git -C "$root" status --porcelain -b --untracked-files="$untracked" 2>/dev/null; then`,
      `    printf '__AC_ERR__\\n'`,
      `  fi`,
      `  printf '__AC_END__\\n'`,
      `done`,
    ].join("\n");

    let carry = "";
    let currentRoot: string | null = null;
    let buf: string[] = [];
    let failed = false;

    const flushBlock = () => {
      if (!currentRoot) return;
      if (!failed) {
        const st = statusFromPorcelain(currentRoot, buf.join("\n"));
        emit(st);
      }
      currentRoot = null;
      buf = [];
      failed = false;
    };

    const consumeLine = (line: string) => {
      if (line.startsWith("__AC_BEGIN__\t")) {
        flushBlock();
        currentRoot = line.slice("__AC_BEGIN__\t".length).trim();
        return;
      }
      if (line === "__AC_END__") {
        flushBlock();
        return;
      }
      if (line === "__AC_ERR__") {
        failed = true;
        return;
      }
      if (currentRoot) buf.push(line);
    };

    await host.run(roots[0]!, "bash", ["-s"], {
      stdin: script,
      timeoutMs: opts?.timeoutMs ?? Math.max(45_000, roots.length * 500),
      onStdoutChunk: (chunk) => {
        carry += chunk;
        const parts = carry.split(/\r?\n/);
        carry = parts.pop() ?? "";
        for (const line of parts) consumeLine(line);
      },
    });
    if (carry) consumeLine(carry);
    flushBlock();
    return collected;
  }

  // Local: sequential, emit as each finishes.
  for (const root of roots) {
    try {
      const st = await loadRepoStatus(host, root, {
        badgeOnly,
        timeoutMs: opts?.timeoutMs,
      });
      emit(st);
    } catch {
      // skip — caller keeps previous status for missing roots
    }
  }
  return collected;
}

function statusFromPorcelain(repoRoot: string, body: string): RepoStatus {
  const { entries, tracking } = parsePorcelainStatusDetailed(body);
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untrackedCount = 0;
  for (const e of entries) {
    if (e.status === "M" || e.status === "R" || e.status === "C") modified += 1;
    else if (e.status === "A") added += 1;
    else if (e.status === "D") deleted += 1;
    else if (e.status === "?") untrackedCount += 1;
  }
  return {
    repoRoot,
    entries,
    modified,
    added,
    deleted,
    untracked: untrackedCount,
    branch: tracking.branch,
    ahead: tracking.ahead,
    behind: tracking.behind,
  };
}

/**
 * List local branches (no remote-only refs).
 * Uses `git branch --format` for a stable parse.
 */
export async function listBranches(
  host: HostSession,
  repoRoot: string,
): Promise<BranchInfo[]> {
  const result = await host.run(repoRoot, "git", [
    "branch",
    "--format=%(refname:short)%09%(HEAD)",
  ]);
  if (result.code !== 0) {
    throw new HostError(
      "failed",
      "Failed to list branches",
      result.stderr || result.stdout,
    );
  }
  const branches: BranchInfo[] = [];
  for (const raw of result.stdout.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    const [name, headMark] = line.split("\t");
    if (!name) continue;
    branches.push({
      name,
      current: headMark === "*",
    });
  }
  branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}

/**
 * Checkout a local branch. Fails cleanly when the worktree has conflicts
 * that block the switch (no --force).
 */
export async function checkoutBranch(
  host: HostSession,
  repoRoot: string,
  branch: string,
): Promise<CheckoutResult> {
  const name = branch.trim();
  if (!name) {
    throw new HostError("failed", "Branch name is required");
  }
  if (name.includes("..") || /[\s~^:?*[\\]/.test(name)) {
    throw new HostError("failed", `Invalid branch name: ${name}`);
  }
  const result = await host.run(repoRoot, "git", ["checkout", name]);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new HostError(
      "failed",
      detail
        ? `Could not switch to ${name}: ${detail}`
        : `Could not switch to ${name}`,
      detail,
    );
  }
  const current = (await resolveBranch(host, repoRoot)) ?? name;
  return { branch: current };
}

/**
 * Stage changes and create a commit with the given message.
 * When `paths` is a non-empty array, only those paths are staged
 * (`git add -- <paths>`); otherwise all changes are staged (`git add -A`).
 */
export async function commitChanges(
  host: HostSession,
  repoRoot: string,
  message: string,
  paths?: string[],
): Promise<CommitResult> {
  const msg = message.trim();
  if (!msg) {
    throw new HostError("failed", "Commit message is required");
  }

  const selectFiles = Array.isArray(paths) && paths.length > 0;
  if (selectFiles) {
    // Verify the selection will actually produce staged changes.
    const add = await host.run(repoRoot, "git", ["add", "--", ...paths]);
    if (add.code !== 0) {
      throw new HostError(
        "failed",
        "Failed to stage selected files",
        add.stderr || add.stdout,
      );
    }
    const cached = await host.run(repoRoot, "git", [
      "diff",
      "--cached",
      "--quiet",
    ]);
    // diff --cached --quiet exits 1 when there are staged changes, 0 when clean.
    if (cached.code === 0) {
      throw new HostError(
        "failed",
        "Nothing to commit — no staged changes for the selected files",
      );
    }
  } else {
    const status = await loadRepoStatus(host, repoRoot);
    const dirty =
      status.modified + status.added + status.deleted + status.untracked;
    if (dirty === 0) {
      throw new HostError(
        "failed",
        "Nothing to commit — working tree is clean",
      );
    }

    const add = await host.run(repoRoot, "git", ["add", "-A"]);
    if (add.code !== 0) {
      throw new HostError(
        "failed",
        "Failed to stage changes",
        add.stderr || add.stdout,
      );
    }
  }

  // -F - reads message from stdin so multi-line / special chars are safe.
  const commit = await host.run(repoRoot, "git", ["commit", "-F", "-"], {
    stdin: msg,
  });
  if (commit.code !== 0) {
    throw new HostError(
      "failed",
      "git commit failed",
      commit.stderr || commit.stdout,
    );
  }

  const rev = await host.run(repoRoot, "git", [
    "log",
    "-1",
    "--format=%H%x09%h%x09%s",
  ]);
  if (rev.code !== 0 || !rev.stdout.trim()) {
    // Commit likely succeeded; return best-effort from message.
    return { hash: "", shortHash: "", subject: msg.split("\n")[0] ?? msg };
  }
  const [hash, shortHash, subject] = rev.stdout.trim().split("\t");
  return {
    hash: hash ?? "",
    shortHash: shortHash ?? "",
    subject: subject ?? msg.split("\n")[0] ?? msg,
  };
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

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

/**
 * Load old + new sides in one host process when possible.
 * Cuts WSL cold-spawn cost roughly in half vs two separate git/cat calls.
 */
export async function getFileDiff(
  host: HostSession,
  repoRoot: string,
  base: string,
  head: string | "worktree",
  filePath: string,
  status: string,
): Promise<FileDiffContent> {
  const needOld = !(status === "?" || status.startsWith("A") || status === "A");
  const needNew = !(status.startsWith("D") || status === "D");

  if (!needOld && !needNew) {
    return { path: filePath, oldText: "", newText: "", status };
  }

  try {
    const both = await loadBothSidesOnce(
      host,
      repoRoot,
      base,
      head,
      filePath,
      needOld,
      needNew,
    );
    if (both) {
      // Worktree new-side empty while old has content usually means cat missed
      // the path on this host — fall back to host.readFile.
      const worktreeMiss =
        head === "worktree" &&
        needNew &&
        both.newText.length === 0 &&
        (!needOld || both.oldText.length > 0);
      if (!worktreeMiss) {
        return { path: filePath, ...both, status };
      }
      if (needOld) {
        // Keep old from combined, only re-read worktree new.
        const abs = hostJoin(host.kind, repoRoot, filePath);
        const newText = await host.readFile(abs).catch(() => "");
        return { path: filePath, oldText: both.oldText, newText, status };
      }
    }
  } catch {
    // fall through
  }

  const oldP = needOld
    ? gitShow(host, repoRoot, `${base}:${filePath}`)
    : Promise.resolve("");
  let newP: Promise<string>;
  if (!needNew) {
    newP = Promise.resolve("");
  } else if (head === "worktree") {
    const abs = hostJoin(host.kind, repoRoot, filePath);
    newP = host.readFile(abs).catch(() => "");
  } else {
    newP = gitShow(host, repoRoot, `${head}:${filePath}`);
  }
  const [oldText, newText] = await Promise.all([oldP, newP]);
  return { path: filePath, oldText, newText, status };
}

async function loadBothSidesOnce(
  host: HostSession,
  repoRoot: string,
  base: string,
  head: string | "worktree",
  filePath: string,
  needOld: boolean,
  needNew: boolean,
): Promise<{ oldText: string; newText: string } | null> {
  // Native Windows may have a Git Bash on PATH, but starting bash.exe for
  // every file is much slower than direct git/readFile calls.
  if (host.kind === "local" && process.platform === "win32") return null;
  const oldCmd = needOld
    ? `git show ${shQuote(`${base}:${filePath}`)} 2>/dev/null || true`
    : "true";
  let newCmd = "true";
  if (needNew) {
    if (head === "worktree") {
      // cwd is already repoRoot — use relative path (portable for local/WSL/SSH).
      newCmd = `cat ${shQuote(filePath)} 2>/dev/null || true`;
    } else {
      newCmd = `git show ${shQuote(`${head}:${filePath}`)} 2>/dev/null || true`;
    }
  }
  // Markers must not appear in source; use low-collision sentinels.
  const script = [
    "set +e",
    "printf '%s\\n' '__AC_OLD_BEGIN__'",
    oldCmd,
    "printf '%s\\n' '__AC_OLD_END__'",
    "printf '%s\\n' '__AC_NEW_BEGIN__'",
    newCmd,
    "printf '%s\\n' '__AC_NEW_END__'",
    "",
  ].join("\n");

  const result = await host.run(repoRoot, "bash", ["-s"], {
    stdin: script,
    timeoutMs: 45_000,
  });
  if (!result.stdout.includes("__AC_OLD_BEGIN__")) return null;
  const oldText = sliceBetween(
    result.stdout,
    "__AC_OLD_BEGIN__",
    "__AC_OLD_END__",
  );
  const newText = sliceBetween(
    result.stdout,
    "__AC_NEW_BEGIN__",
    "__AC_NEW_END__",
  );
  if (oldText === null || newText === null) return null;
  return { oldText, newText };
}

function sliceBetween(
  text: string,
  begin: string,
  end: string,
): string | null {
  const bi = text.indexOf(begin);
  if (bi < 0) return null;
  let bodyStart = bi + begin.length;
  // Marker is printed with a trailing newline; skip it only.
  if (text.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (text.startsWith("\n", bodyStart)) bodyStart += 1;
  const ei = text.indexOf(end, bodyStart);
  if (ei < 0) return null;
  // End marker sits at the start of its line; drop the separator newline before it.
  let bodyEnd = ei;
  if (bodyEnd > bodyStart && text[bodyEnd - 1] === "\n") {
    bodyEnd -= 1;
    if (bodyEnd > bodyStart && text[bodyEnd - 1] === "\r") bodyEnd -= 1;
  }
  return text.slice(bodyStart, bodyEnd);
}
