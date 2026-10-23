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
import { HostError, type HostSession } from "../host/types.js";

export class CommentFacade {
  private readonly mutations = new WeakMap<HostSession, Map<string, Promise<void>>>();

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
    const { host, root } = await this.commentContext(repoRoot);
    return loadSessions(host, root);
  }
  async summaries(repoRoot: string) {
    const { host, root } = await this.commentContext(repoRoot);
    return listSessionSummaries(host, root);
  }
  async ensureSession(repoRoot: string, title?: string, author = "local-user") {
    return this.mutate(repoRoot, (host, root) => ensureActiveSession(host, root, author, title));
  }
  async add(input: AddCommentInput, options: { author?: string } = {}) {
    // Validate while this workspace/host is still current; queued saves retain
    // that context even if the user switches workspace before the write starts.
    const filePath = this.workspace.safeRepoPath(this.workspace.root(), input.filePath);
    return this.mutate(input.repoRoot, (host, repoRoot) => addComment(host, {
      ...input,
      repoRoot,
      filePath,
      author: options.author ?? input.author ?? "local-user",
    }));
  }
  async setStatus(repoRoot: string, commentId: string, status: CommentStatus) {
    return this.mutate(repoRoot, (host, root) => setCommentStatus(host, root, commentId, status));
  }
  async reply(repoRoot: string, commentId: string, body: string, author = "local-user") {
    return this.mutate(repoRoot, (host, root) => replyComment(host, root, commentId, body, author));
  }
  async edit(repoRoot: string, commentId: string, body: string, messageId?: string) {
    return this.mutate(repoRoot, (host, root) => editComment(host, root, commentId, body, messageId));
  }
  async remove(repoRoot: string, commentId: string) {
    return this.mutate(repoRoot, (host, root) => deleteComment(host, root, commentId));
  }
  async end(repoRoot: string, options: { export: boolean; sessionId?: string }) {
    return this.mutate(repoRoot, (host, root) => endSession(host, root, options));
  }
  async create(repoRoot: string, title?: string, author = "local-user") {
    return this.mutate(repoRoot, (host, root) => newSession(host, root, author, title));
  }
  async restore(repoRoot: string, sessionId: string) {
    return this.mutate(repoRoot, (host, root) => restoreSession(host, root, sessionId));
  }
  async export(repoRoot: string, sessionId?: string) {
    return this.mutate(repoRoot, (host, root) => exportSession(host, root, sessionId));
  }
  async yamlPath(repoRoot: string, sessionId?: string) {
    return this.mutate(repoRoot, (host, root) => copyYamlPath(host, root, sessionId));
  }

  /** Serialize read-modify-write saves, while lists and other workspaces stay independent. */
  private async mutate<T>(input: string, action: (host: HostSession, root: string) => Promise<T>): Promise<T> {
    const { host, root } = await this.commentContext(input);
    const queue = this.mutations.get(host) ?? new Map<string, Promise<void>>();
    this.mutations.set(host, queue);
    const key = this.pathKey(host, root);
    const result = (queue.get(key) ?? Promise.resolve()).then(() => action(host, root));
    const settled = result.then(() => undefined, () => undefined);
    queue.set(key, settled);
    void settled.then(() => { if (queue.get(key) === settled) queue.delete(key); });
    return result;
  }

  private async commentContext(input: string): Promise<{ host: HostSession; root: string }> {
    const host = this.hosts.session;
    const candidate = this.workspace.safePath(input);
    const root = hostNormalize(host.kind, this.workspace.root());
    const normalizedCandidate = hostNormalize(host.kind, candidate);
    if (this.pathKey(host, normalizedCandidate) === this.pathKey(host, root)) return { host, root };
    const repos = await discoverRepos(host, root);
    const approvedRepo = repos.some(
      (repo) => this.pathKey(host, repo.root) === this.pathKey(host, normalizedCandidate),
    );
    if (!approvedRepo) {
      throw new HostError(
        "permission",
        "Comment repository is not approved in the active workspace",
      );
    }
    return { host, root };
  }

  private pathKey(host: HostSession, input: string): string {
    const normalized = hostNormalize(host.kind, input).replace(/\\/g, "/");
    return host.kind === "local" && process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  }
}
