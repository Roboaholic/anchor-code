import type { HostManager } from "../host/hostManager.js";
import {
  addComment,
  copyYamlPath,
  deleteComment,
  editComment,
  endSession,
  ensureActiveSession,
  exportSession,
  loadSessions,
  listSessionSummaries,
  locateGitRoot,
  newSession,
  replyComment,
  restoreSession,
  setCommentStatus,
  type AddCommentInput,
  type CommentStatus,
} from "../services/annotationsService.js";
import { discoverRepos } from "../services/historyService.js";
import type { WorkspaceFacade } from "./workspaceFacade.js";
import { hostNormalize } from "../host/paths.js";
import { HostError } from "../host/types.js";

export class CommentFacade {
  constructor(
    private readonly hosts: HostManager,
    private readonly workspace: WorkspaceFacade,
  ) {}

  async locateRoot(filePath: string) {
    const safeFile = this.workspace.safePath(filePath);
    const root = await locateGitRoot(this.hosts.session, safeFile);
    if (!root) return null;
    try {
      return this.workspace.safePath(root);
    } catch {
      return null;
    }
  }
  async list(repoRoot: string) {
    return loadSessions(this.hosts.session, await this.commentRoot(repoRoot));
  }
  async summaries(repoRoot: string) {
    return listSessionSummaries(this.hosts.session, await this.commentRoot(repoRoot));
  }
  async ensureSession(repoRoot: string, title?: string, author = "local-user") {
    return ensureActiveSession(this.hosts.session, await this.commentRoot(repoRoot), author, title);
  }
  async add(input: AddCommentInput, options: { author?: string } = {}) {
    const repoRoot = await this.commentRoot(input.repoRoot);
    return addComment(this.hosts.session, {
      ...input,
      repoRoot,
      filePath: this.workspace.safeRepoPath(repoRoot, input.filePath),
      author: options.author ?? input.author ?? "local-user",
    });
  }
  async setStatus(repoRoot: string, commentId: string, status: CommentStatus) {
    return setCommentStatus(this.hosts.session, await this.commentRoot(repoRoot), commentId, status);
  }
  async reply(repoRoot: string, commentId: string, body: string, author = "local-user") {
    return replyComment(this.hosts.session, await this.commentRoot(repoRoot), commentId, body, author);
  }
  async edit(repoRoot: string, commentId: string, body: string, messageId?: string) {
    return editComment(this.hosts.session, await this.commentRoot(repoRoot), commentId, body, messageId);
  }
  async remove(repoRoot: string, commentId: string) {
    return deleteComment(this.hosts.session, await this.commentRoot(repoRoot), commentId);
  }
  async end(repoRoot: string, options: { export: boolean; sessionId?: string }) {
    return endSession(this.hosts.session, await this.commentRoot(repoRoot), options);
  }
  async create(repoRoot: string, title?: string, author = "local-user") {
    return newSession(this.hosts.session, await this.commentRoot(repoRoot), author, title);
  }
  async restore(repoRoot: string, sessionId: string) {
    return restoreSession(this.hosts.session, await this.commentRoot(repoRoot), sessionId);
  }
  async export(repoRoot: string, sessionId?: string) {
    return exportSession(this.hosts.session, await this.commentRoot(repoRoot), sessionId);
  }
  async yamlPath(repoRoot: string, sessionId?: string) {
    return copyYamlPath(this.hosts.session, await this.commentRoot(repoRoot), sessionId);
  }

  private async commentRoot(input: string): Promise<string> {
    const candidate = this.workspace.safePath(input);
    const root = hostNormalize(this.hosts.session.kind, this.workspace.root());
    const normalizedCandidate = hostNormalize(this.hosts.session.kind, candidate);
    if (this.pathKey(normalizedCandidate) === this.pathKey(root)) return root;
    const repos = await discoverRepos(this.hosts.session, root);
    const approvedRepo = repos.some(
      (repo) => this.pathKey(repo.root) === this.pathKey(normalizedCandidate),
    );
    if (!approvedRepo) {
      throw new HostError(
        "permission",
        "Comment repository is not approved in the active workspace",
      );
    }
    return root;
  }

  private pathKey(input: string): string {
    const normalized = hostNormalize(this.hosts.session.kind, input).replace(/\\/g, "/");
    return this.hosts.session.kind === "local" && process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  }
}
