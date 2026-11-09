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
import { imageMimeType } from "./imageMime.js";
import { snapshotFileDiffWithAlternates } from "../services/snapshotService.js";

/** Returns an external snapshot store objects dir when base/head live there. */
export type SnapshotAlternatesResolver = (
  repoRoot: string,
  revs: string[],
) => Promise<string | null>;

const MAX_READ_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

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

  /**
   * Read a workspace image for `<img>` previews. Only known image extensions
   * are served, and SVG is labelled image/svg+xml so the renderer never has
   * to inject markup (scripts inside an SVG do not run in an <img>).
   */
  async readImage(path: string): Promise<{ path: string; mime: string; base64: string; size: number }> {
    const safePath = this.workspace.safePath(path);
    const mime = imageMimeType(safePath);
    if (!mime) throw new HostError("failed", `Not an image file: ${safePath}`);
    const host = this.hosts.session;
    const bytes = await host.readFileBytes(safePath, MAX_IMAGE_BYTES);
    return { path: safePath, mime, base64: bytes.toString("base64"), size: bytes.length };
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
  private snapshotAlternates: SnapshotAlternatesResolver | null = null;

  setSnapshotAlternatesResolver(fn: SnapshotAlternatesResolver | null): void {
    this.snapshotAlternates = fn;
  }

  async fileDiff(input: { repoRoot: string; base: string; head: string | "worktree"; path: string; status: string }) {
    const repoRoot = await this.approvedRepoRoot(input.repoRoot);
    const filePath = this.relativeRepoPath(repoRoot, input.path);
    const alternates = this.snapshotAlternates
      ? await this.snapshotAlternates(repoRoot, [input.base, input.head]).catch(() => null)
      : null;
    if (alternates) {
      return snapshotFileDiffWithAlternates(
        this.hosts.session,
        repoRoot,
        input.base,
        input.head,
        filePath,
        input.status,
        alternates,
      );
    }
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
    const host = this.hosts.session;
    const workspaceKey = this.pathKey(this.workspace.root());
    const cacheKey = (candidate: string) => `${host.id}\0${workspaceKey}\0${this.pathKey(candidate)}`;
    let pending = [...new Set(candidates)].filter((c) => !this.approvedRepoCache.has(cacheKey(c)));
    if (pending.length === 0) return candidates;

    // Roots that this session's discovery pass already found (and validated
    // on the host) in this workspace need no extra round trip. Over SSH each
    // `git rev-parse` was a fresh handshake, 2 at a time per alias: ~20 of
    // them queued ahead of the first Repos status on every new workspace.
    const discovered = await this.discoveredRootKeys(host);
    if (discovered) {
      pending = pending.filter((c) => {
        if (!discovered.has(this.pathKey(c))) return true;
        this.approvedRepoCache.add(cacheKey(c));
        return false;
      });
    }
    if (pending.length === 0) return candidates;

    const tops = host.kind === "local" || pending.length === 1
      ? await Promise.all(pending.map((c) => this.showToplevel(c)))
      : await this.showToplevels(pending);
    pending.forEach((candidate, i) => {
      const actualRoot = tops[i];
      if (!actualRoot || this.pathKey(actualRoot) !== this.pathKey(candidate)) {
        throw new HostError(
          "permission",
          "Repository is not an approved Git repository in the active workspace",
        );
      }
      this.approvedRepoCache.add(cacheKey(candidate));
    });
    return candidates;
  }

  /** Path keys of the cached discovery result for the active workspace (never starts a scan). */
  private async discoveredRootKeys(host: HostManager["session"]): Promise<Set<string> | null> {
    const hit = this.repoCache.get(`${host.id}\0${this.pathKey(this.workspace.root())}`);
    if (!hit) return null;
    try {
      return new Set((await hit).map((r) => this.pathKey(r.root)));
    } catch {
      return null;
    }
  }

  private async showToplevel(candidate: string): Promise<string | null> {
    const result = await readRun(this.hosts.session, candidate, "git", ["rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
    return result.code === 0 ? result.stdout.trim() || null : null;
  }

  /** One remote command for many candidates (WSL/SSH): one line per candidate, in order. */
  private async showToplevels(candidates: string[]): Promise<(string | null)[]> {
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const script = candidates
      .map((c, i) => `printf '%s\\t%s\\n' ${i} "$(cd -- ${q(c)} 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"`)
      .join("\n");
    const result = await readRun(this.hosts.session, this.workspace.root(), "bash", ["-s"], {
      stdin: script + "\n",
      timeoutMs: Math.max(10_000, candidates.length * 1_000),
    });
    const out: (string | null)[] = candidates.map(() => null);
    for (const line of result.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const i = Number(line.slice(0, tab));
      const top = line.slice(tab + 1).trim();
      if (Number.isInteger(i) && i >= 0 && i < out.length && top) out[i] = top;
    }
    return out;
  }

  private pathKey(input: string): string {
    const normalized = hostNormalize(this.hosts.session.kind, input).replace(/\\/g, "/");
    return this.hosts.session.kind === "local" && process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  }
}
