import type { HostManager } from "../host/hostManager.js";
import { HostError } from "../host/types.js";
import {
  DEFAULT_MAX_FILES,
  findWorkspaceFiles,
} from "../services/fileIndex.js";
import {
  ANCHOR_IGNORE_FILE,
  DEFAULT_EXCLUDES,
  invalidateAnchorIgnoreCache,
  loadAnchorIgnore,
  mergeAnchorIgnore,
  pathMatchesGlobs,
  searchWorkspaceContent,
} from "../services/contentSearch.js";
import { hostJoin } from "../host/paths.js";
import {
  checkoutBranch,
  commitChanges,
  compareCommits,
  compareToWorktree,
  discoverRepos,
  readRun,
  getFileDiff,
  listBranches,
  loadFileBlame,
  loadLog,
  loadRepoExpandBundle,
  loadRepoStatus,
  loadRepoStatusesBulk,
} from "../services/historyService.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";
import { hostNormalize } from "../host/paths.js";

const MAX_READ_BYTES = 1024 * 1024;

export class ReviewFacade {
  constructor(
    private readonly hosts: HostManager,
    private readonly workspace: WorkspaceFacade,
  ) {}
  private readonly approvedRepoCache = new Set<string>();

  async listFiles(path?: string | null) {
    const safePath = this.workspace.safePath(path);
    return { path: safePath, entries: await this.hosts.session.listDir(safePath) };
  }

  async readFile(path: string) {
    const safePath = this.workspace.safePath(path);
    const host = this.hosts.session;
    const stat = await host.stat(safePath);
    if (!stat.isFile) throw new HostError("failed", `Not a file: ${safePath}`);
    const text = await host.readFile(safePath, { maxBytes: MAX_READ_BYTES });
    return {
      path: safePath,
      text,
      size: stat.size,
      truncated: stat.size > MAX_READ_BYTES,
    };
  }

  async fileIndex(
    maxFiles = DEFAULT_MAX_FILES,
    root = this.workspace.root(),
    query?: string,
    opts?: {
      defaultExcludes?: string[];
      respectIgnore?: boolean;
    },
  ) {
    const respectIgnore = opts?.respectIgnore !== false;
    const defaults = respectIgnore
      ? (opts?.defaultExcludes ?? DEFAULT_EXCLUDES)
      : [];
    const anchorIgnore = respectIgnore
      ? await loadAnchorIgnore(this.hosts.session, root)
      : [];
    const exclude = [...defaults, ...anchorIgnore];
    const pruneDirNames = exclude.filter(
      (p) => p && !p.includes("/") && !/[*?[\]{}]/.test(p),
    );
    const result = await findWorkspaceFiles(this.hosts.session, root, {
      maxFiles,
      query,
      pruneDirNames,
    });
    if (exclude.length === 0) return result;
    const files = result.files.filter((f) =>
      pathMatchesGlobs(f.replace(/\\/g, "/"), [], exclude),
    );
    return { ...result, files };
  }

  search(
    query: string,
    options: Parameters<typeof searchWorkspaceContent>[3] = {},
    root = this.workspace.root(),
  ) {
    return searchWorkspaceContent(this.hosts.session, root, query, options);
  }

  /** Current `<root>/.anchorignore` text ("" when missing) + built-in defaults. */
  async readSearchIgnore(root = this.workspace.root()) {
    const safeRoot = this.workspace.safePath(root);
    const file = hostJoin(this.hosts.session.kind, safeRoot, ANCHOR_IGNORE_FILE);
    let text = "";
    try {
      text = await this.hosts.session.readFile(file);
    } catch {
      // missing is fine
    }
    return { path: file, text, defaultExcludes: [...DEFAULT_EXCLUDES] };
  }

  /** Append exclude patterns to `<root>/.anchorignore` (deduplicated). */
  async saveSearchExcludes(patterns: string[], root = this.workspace.root()) {
    const current = await this.readSearchIgnore(root);
    const next = mergeAnchorIgnore(
      current.text,
      patterns.filter((p) => typeof p === "string"),
    );
    if (next !== current.text) {
      await this.hosts.session.writeFile(current.path, next);
    }
    invalidateAnchorIgnoreCache();
    return { path: current.path, text: next, changed: next !== current.text };
  }

  /** Discovered git roots per host session + workspace root (Rescan forces). */
  private readonly repoCache = new Map<string, Promise<Awaited<ReturnType<typeof discoverRepos>>>>();

  repos(root = this.workspace.root(), opts?: { force?: boolean }) {
    const host = this.hosts.session;
    const safe = this.workspace.safePath(root);
    const key = `${host.id}\0${this.pathKey(safe)}`;
    const hit = this.repoCache.get(key);
    if (hit && !opts?.force) return hit;
    const run = discoverRepos(host, safe);
    this.repoCache.set(key, run);
    run.catch(() => {
      if (this.repoCache.get(key) === run) this.repoCache.delete(key);
    });
    return run;
  }
  async log(
    repoRoot: string,
    opts?: { limit?: number; skip?: number; since?: string },
  ) {
    return loadLog(this.hosts.session, await this.approvedRepoRoot(repoRoot), opts);
  }
  async expandBundle(repoRoot: string, opts?: { logLimit?: number }) {
    return loadRepoExpandBundle(
      this.hosts.session,
      await this.approvedRepoRoot(repoRoot),
      opts,
    );
  }
  async blame(repoRoot: string, filePath: string, revision?: string) {
    const root = await this.approvedRepoRoot(repoRoot);
    const absolute = this.workspace.safeRepoPath(root, filePath);
    return loadFileBlame(this.hosts.session, root, absolute, revision);
  }
  async status(repoRoot: string, options?: { badgeOnly?: boolean; scanUntracked?: boolean }) {
    return loadRepoStatus(this.hosts.session, await this.approvedRepoRoot(repoRoot), options);
  }
  async statusBulk(
    repoRoots: string[],
    options?: Parameters<typeof loadRepoStatusesBulk>[2],
  ) {
    const approved = await this.approvedRepoRoots(repoRoots);
    return loadRepoStatusesBulk(this.hosts.session, approved, options);
  }
  async branches(repoRoot: string) {
    return listBranches(this.hosts.session, await this.approvedRepoRoot(repoRoot));
  }
  async checkout(repoRoot: string, branch: string) {
    return checkoutBranch(this.hosts.session, await this.approvedRepoRoot(repoRoot), branch);
  }
  async commit(repoRoot: string, message: string, paths?: string[]) {
    const root = await this.approvedRepoRoot(repoRoot);
    const safePaths = paths?.map((filePath) => this.relativeRepoPath(root, filePath));
    return commitChanges(this.hosts.session, root, message, safePaths);
  }
  async compare(repoRoot: string, base: string, head: string | "worktree") {
    const root = await this.approvedRepoRoot(repoRoot);
    return head === "worktree"
      ? compareToWorktree(this.hosts.session, root, base)
      : compareCommits(this.hosts.session, root, base, head);
  }
  async fileDiff(input: { repoRoot: string; base: string; head: string | "worktree"; path: string; status: string }) {
    const repoRoot = await this.approvedRepoRoot(input.repoRoot);
    const filePath = this.relativeRepoPath(repoRoot, input.path);
    return getFileDiff(
      this.hosts.session,
      repoRoot,
      input.base,
      input.head,
      filePath,
      input.status,
    );
  }

  private relativeRepoPath(repoRoot: string, input: string): string {
    const absolute = this.workspace.safeRepoPath(repoRoot, input);
    const root = hostNormalize(this.hosts.session.kind, repoRoot)
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    const normalized = hostNormalize(this.hosts.session.kind, absolute).replace(/\\/g, "/");
    const relative = normalized === root ? "" : normalized.slice(root.length + 1);
    if (!relative) {
      throw new HostError("permission", "A repository path is required");
    }
    return relative;
  }

  private async approvedRepoRoot(input: string): Promise<string> {
    return (await this.approvedRepoRoots([input]))[0]!;
  }

  private async approvedRepoRoots(inputs: string[]): Promise<string[]> {
    const candidates = inputs.map((input) => this.workspace.safePath(input));
    await Promise.all(candidates.map((candidate) => this.approveRepoRoot(candidate)));
    return candidates;
  }

  private async approveRepoRoot(candidate: string): Promise<void> {
    const cacheKey = `${this.hosts.session.id}\0${this.pathKey(this.workspace.root())}\0${this.pathKey(candidate)}`;
    if (this.approvedRepoCache.has(cacheKey)) return;

    const result = await readRun(this.hosts.session, candidate, "git", [
      "rev-parse",
      "--show-toplevel",
    ], { timeoutMs: 10_000 });
    const actualRoot = result.stdout.trim();
    if (result.code !== 0 || !actualRoot || this.pathKey(actualRoot) !== this.pathKey(candidate)) {
      throw new HostError(
        "permission",
        "Repository is not an approved Git repository in the active workspace",
      );
    }
    this.approvedRepoCache.add(cacheKey);
  }

  private pathKey(input: string): string {
    const normalized = hostNormalize(this.hosts.session.kind, input).replace(/\\/g, "/");
    return this.hosts.session.kind === "local" && process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  }
}
