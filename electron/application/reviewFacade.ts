import type { HostManager } from "../host/hostManager.js";
import { HostError } from "../host/types.js";
import { findWorkspaceFiles } from "../services/fileIndex.js";
import { searchWorkspaceContent } from "../services/contentSearch.js";
import {
  checkoutBranch,
  commitChanges,
  compareCommits,
  compareToWorktree,
  discoverRepos,
  getFileDiff,
  listBranches,
  loadFileBlame,
  loadLog,
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

  async listFiles(path?: string | null) {
    const safePath = this.workspace.safePath(path);
    return { path: safePath, entries: await this.hosts.session.listDir(safePath) };
  }

  async readFile(path: string) {
    const safePath = this.workspace.safePath(path);
    const stat = await this.hosts.session.stat(safePath);
    if (!stat.isFile) throw new HostError("failed", `Not a file: ${safePath}`);
    const text = await this.hosts.session.readFile(safePath);
    return {
      path: safePath,
      text: text.slice(0, MAX_READ_BYTES),
      size: stat.size,
      truncated: stat.size > MAX_READ_BYTES,
    };
  }

  fileIndex(maxFiles = 5000, root = this.workspace.root(), query?: string) {
    return findWorkspaceFiles(this.hosts.session, root, { maxFiles, query });
  }

  search(
    query: string,
    options: Parameters<typeof searchWorkspaceContent>[3] = {},
    root = this.workspace.root(),
  ) {
    return searchWorkspaceContent(this.hosts.session, root, query, options);
  }

  repos(root = this.workspace.root()) {
    return discoverRepos(this.hosts.session, this.workspace.safePath(root));
  }
  async log(repoRoot: string) {
    return loadLog(this.hosts.session, await this.approvedRepoRoot(repoRoot));
  }
  async blame(repoRoot: string, filePath: string, revision?: string) {
    const root = await this.approvedRepoRoot(repoRoot);
    const absolute = this.workspace.safeRepoPath(root, filePath);
    return loadFileBlame(this.hosts.session, root, absolute, revision);
  }
  async status(repoRoot: string, options?: { badgeOnly?: boolean }) {
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
    const repos = await discoverRepos(this.hosts.session, this.workspace.root());
    const approvedRoots = new Set(
      repos.map((repo) => this.pathKey(repo.root)),
    );
    for (const candidate of candidates) {
      if (!approvedRoots.has(this.pathKey(candidate))) {
        throw new HostError(
          "permission",
          "Repository is not an approved Git repository in the active workspace",
        );
      }
    }
    return candidates;
  }

  private pathKey(input: string): string {
    const normalized = hostNormalize(this.hosts.session.kind, input).replace(/\\/g, "/");
    return this.hosts.session.kind === "local" && process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  }
}
