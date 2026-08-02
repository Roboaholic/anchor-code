import {
  AnchorRemoteApi,
  RemoteApiError,
  type Connection,
  type RequestOptions,
} from "./api";
import type {
  CreateAgentSessionInput,
  AddRemoteCommentInput,
  RemoteCommentRecord,
  RemoteCapability,
  RemoteCommentSession,
  RemoteCommit,
  RemoteDiffFile,
  RemoteDirEntry,
  RemoteFileDiff,
  RemoteBootstrap,
  RemoteMeta,
  RemoteReadFileResult,
  RemoteRepoStatus,
  RemoteSearchHit,
  RemoteTerminalEvents,
  RemoteTerminalInfo,
  RemoteTerminalSnapshot,
  RemoteWorkspaceCatalog,
  RemoteWorkspaceRef,
} from "@anchor-code/remote-contract/v1";
import { REMOTE_API_MAJOR } from "@anchor-code/remote-contract/v1";

export type Entry = RemoteDirEntry;
export type Commit = RemoteCommit;
export type DiffFile = RemoteDiffFile;
export type RepoStatus = RemoteRepoStatus;
export type CommentRecord = RemoteCommentRecord;
export type Session = RemoteCommentSession;

export class AnchorRepositories {
  private readonly transport: AnchorRemoteApi;
  private advertisedCapabilities: ReadonlySet<RemoteCapability> | null = null;

  constructor(connection: Connection) {
    this.transport = new AnchorRemoteApi(connection);
  }

  supports(capability: RemoteCapability): boolean {
    return this.advertisedCapabilities?.has(capability) ?? true;
  }

  private rememberCapabilities(capabilities: RemoteCapability[] | undefined): void {
    if (Array.isArray(capabilities)) {
      this.advertisedCapabilities = new Set(capabilities);
    }
  }

  readonly system = {
    meta: (options?: RequestOptions) => this.transport.get<RemoteMeta>("/api/v1/meta", options),
    health: (options?: RequestOptions) => this.transport.get<{ ok: boolean }>("/api/v1/health", options),
    bootstrap: async (options?: RequestOptions) => {
      const bootstrap = await this.transport.get<RemoteBootstrap>("/api/v1/bootstrap", options);
      this.rememberCapabilities(bootstrap.capabilities);
      return bootstrap;
    },
    negotiate: async (options?: RequestOptions): Promise<RemoteMeta | null> => {
      try {
        const meta = await this.transport.get<RemoteMeta>("/api/v1/meta", options);
        const major = Number.parseInt(meta.protocolVersion.split(".")[0] ?? "", 10);
        if (major !== REMOTE_API_MAJOR) {
          throw new Error(`PC 协议版本 ${meta.protocolVersion} 与 App 不兼容，请升级 PC 或 App`);
        }
        this.rememberCapabilities(meta.capabilities);
        return meta;
      } catch (error) {
        if (error instanceof RemoteApiError && error.status === 404) return null;
        throw error;
      }
    },
  };

  readonly workspace = {
    list: (options?: RequestOptions) => this.transport.get<RemoteWorkspaceCatalog>("/api/v1/workspaces", options),
    select: (workspace: RemoteWorkspaceRef) => this.transport.post<{ ok: true }>("/api/v1/workspaces/select", workspace),
    listFiles: (path: string) => this.transport.get<{ path: string; entries: Entry[] }>(`/api/v1/files?path=${encodeURIComponent(path)}`),
    readFile: (path: string) => this.transport.get<RemoteReadFileResult>(`/api/v1/file?path=${encodeURIComponent(path)}`),
    search: (query: string, maxResults = 80) => this.transport.get<{ hits: RemoteSearchHit[] }>(`/api/v1/search?q=${encodeURIComponent(query)}&maxResults=${maxResults}`),
  };

  readonly review = {
    status: (repoRoot: string) => this.transport.get<RepoStatus>(`/api/v1/history/status?repoRoot=${encodeURIComponent(repoRoot)}`),
    log: (repoRoot: string) => this.transport.get<Commit[]>(`/api/v1/history/log?repoRoot=${encodeURIComponent(repoRoot)}`),
    compare: (input: { repoRoot: string; base: string; head: string | "worktree" }) => this.transport.post<{ files: DiffFile[] }>("/api/v1/history/compare", input),
    fileDiff: (input: { repoRoot: string; base: string; head: string | "worktree"; path: string; status: string }) => this.transport.post<RemoteFileDiff>("/api/v1/history/file-diff", input),
  };

  readonly comments = {
    list: (repoRoot: string) => this.transport.get<{ sessions: Session[] }>(`/api/v1/comments?repoRoot=${encodeURIComponent(repoRoot)}`),
    add: (input: AddRemoteCommentInput) => this.transport.post<Session>("/api/v1/comments", input),
    setStatus: (repoRoot: string, commentId: string, status: CommentRecord["status"]) => this.transport.patch<Session>(`/api/v1/comments/${encodeURIComponent(commentId)}/status`, { repoRoot, status }),
    reply: (repoRoot: string, commentId: string, body: string) => this.transport.post<Session>(`/api/v1/comments/${encodeURIComponent(commentId)}/reply`, { repoRoot, body }),
  };

  readonly agent = {
    createSession: (input: CreateAgentSessionInput) => this.transport.post<RemoteTerminalInfo>("/api/v1/agents/sessions", input),
  };

  readonly terminal = {
    snapshot: (id: string, afterSeq?: number) => this.transport.get<RemoteTerminalSnapshot>(
      `/api/v1/terminals/${encodeURIComponent(id)}${typeof afterSeq === "number" ? `?afterSeq=${afterSeq}` : ""}`,
    ),
    input: (id: string, data: string) => this.transport.post<{ ok: true }>(`/api/v1/terminals/${encodeURIComponent(id)}/input`, { data }),
    resize: (id: string, cols: number, rows: number) => this.transport.post<{ ok: true }>(`/api/v1/terminals/${encodeURIComponent(id)}/resize`, { cols, rows }),
    remove: (id: string) => this.transport.delete<{ ok: true }>(`/api/v1/terminals/${encodeURIComponent(id)}`),
    pollEvents: (after: number, waitMs = 15_000) => this.transport.get<RemoteTerminalEvents>(`/api/v1/terminal-events?after=${after}&waitMs=${waitMs}`, { timeoutMs: waitMs + 7_000 }),
  };
}

export type WorkspaceCatalog = RemoteWorkspaceCatalog;
export type WorkspaceOption = RemoteWorkspaceCatalog["recent"][number];
