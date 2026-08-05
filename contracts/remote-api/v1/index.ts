export const REMOTE_API_MAJOR = 1 as const;
export const REMOTE_PROTOCOL_VERSION = "1.0" as const;
export const REMOTE_MIN_PROTOCOL_VERSION = "1.0" as const;

export const REMOTE_V1_PATHS = [
  "/meta",
  "/health",
  "/bootstrap",
  "/workspaces",
  "/workspaces/select",
  "/files",
  "/file",
  "/file-index",
  "/search",
  "/repos",
  "/history/log",
  "/history/status",
  "/history/compare",
  "/history/file-diff",
  "/comments",
  "/comments/session",
  "/comments/{commentId}",
  "/comments/{commentId}/status",
  "/comments/{commentId}/reply",
  "/comments/{commentId}/edit",
  "/comments/end-session",
  "/comments/new-session",
  "/comments/restore-session",
  "/comments/export",
  "/agents",
  "/agents/launch-options",
  "/agents/sessions",
  "/terminals",
  "/terminal-events",
  "/terminals/{terminalId}",
  "/terminals/{terminalId}/input",
  "/terminals/{terminalId}/resize",
] as const;

export const REMOTE_CAPABILITIES = [
  "workspace.select",
  "review.inline-diff",
  "review.side-by-side-diff",
  "comments.lifecycle",
  "agent.session-sync",
  "terminal.snapshot-seq",
  "terminal.long-poll-events",
  "workspace.events",
  "system.instance-recovery",
] as const;

export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];

export interface RemoteMeta {
  serverVersion: string;
  protocolVersion: string;
  minProtocolVersion: string;
  capabilities: RemoteCapability[];
  serverInstanceId: string;
}

export interface RemoteErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
    retryable?: boolean;
  };
}

export interface RemoteWorkspaceRef {
  path: string;
  hostProfileId: string;
}

export interface RemoteWorkspaceOption extends RemoteWorkspaceRef {
  lastOpenedAt: string;
  name: string;
  hostKind: string;
  hostLabel: string;
}

export interface RemoteWorkspaceCatalog {
  active: RemoteWorkspaceRef | null;
  recent: RemoteWorkspaceOption[];
}

export interface RemoteTerminalInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
  kind: "shell" | "agent";
  agentId?: string;
  agentSessionId?: string;
  titleSource?: "default" | "user" | "inferred";
}

export interface RemoteTerminalSnapshot {
  id: string;
  data: string;
  seq: number;
  /** True when afterSeq already matches the latest output and data is omitted. */
  unchanged?: boolean;
}

export type RemoteTerminalEvent =
  | { type: "created" | "updated"; info: RemoteTerminalInfo }
  | { type: "data"; id: string; data: string; seq: number }
  | { type: "exit"; id: string; exitCode: number; kind: "shell" | "agent" }
  | { type: "removed"; id: string; kind: "shell" | "agent" };

export type RemoteApplicationEvent =
  | RemoteTerminalEvent
  | {
      type: "workspace";
      workspace: {
        path: string;
        name: string;
        hostProfileId: string;
        hostKind: string;
      };
    };

export interface RemoteEventEnvelope {
  seq: number;
  at: string;
  serverInstanceId: string;
  event: RemoteApplicationEvent;
}

export interface RemoteTerminalEvents {
  cursor: number;
  serverInstanceId: string;
  /** The requested cursor fell out of the bounded event cache. */
  bootstrapRequired: boolean;
  events: RemoteEventEnvelope[];
}

export interface RemoteBootstrap {
  version: string;
  protocolVersion: string;
  capabilities: RemoteCapability[];
  serverInstanceId: string;
  host: { kind: string; profileId: string };
  workspace: { root: string; name: string };
  repos: Array<{ root: string; name: string }>;
  agents: RemoteAgentProfile[];
  defaultAgentId?: string;
  terminals: RemoteTerminalInfo[];
  terminalCursor: number;
}

export interface RemoteAgentProfile {
  id: string;
  name: string;
  command: string;
  args?: string[];
  detected?: boolean;
  enabled?: boolean;
}

export interface RemoteAgentModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
  hidden?: boolean;
}

export interface RemoteAgentLaunchOptions {
  profileId: string;
  supportsModel: boolean;
  supportsEffort: boolean;
  models: RemoteAgentModelOption[];
  defaultModel?: string;
  defaultEffort?: string;
  source?: string;
  error?: string;
  cached?: boolean;
}

export interface CreateAgentSessionInput {
  profileId: string;
  model?: string;
  effort?: string;
  prompt?: string;
  resume?: boolean;
  sessionId?: string;
  cols?: number;
  rows?: number;
}

export interface RemoteDirEntry {
  name: string;
  type: "file" | "dir";
}

export interface RemoteReadFileResult {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
}

export interface RemoteFileIndex {
  root: string;
  files: string[];
  truncated: boolean;
  source: "git" | "walk" | "multi-git";
}

export interface RemoteSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface RemoteCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  dateIso: string;
}

export interface RemoteDiffFile {
  path: string;
  status: string;
}

export interface RemoteRepoStatus {
  repoRoot?: string;
  entries: Array<{ path: string; status: string; code: string }>;
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  branch: string | null;
  ahead?: number | null;
  behind?: number | null;
}

export interface RemoteFileDiff {
  path: string;
  oldText: string;
  newText: string;
  status: string;
}

export type RemoteCommentStatus = "discussing" | "need_modify" | "closed";

export interface RemoteCommentRecord {
  id: string;
  status: RemoteCommentStatus;
  target: {
    file_path: string;
    kind: "source" | "markdown";
    start_line: number;
    end_line: number;
    start_column?: number;
    end_column?: number;
    selected_text: string;
    before_context?: string;
    after_context?: string;
  };
  created_at: string;
  updated_at: string;
  author: string;
  messages: Array<{ id: string; author: string; body: string; created_at: string }>;
}

export interface RemoteCommentSession {
  version: 1;
  id: string;
  title: string;
  status: "active" | "closed";
  created_at: string;
  ended_at: string | null;
  author: string;
  notes: string;
  filePath?: string;
  comments: RemoteCommentRecord[];
}

export interface AddRemoteCommentInput {
  repoRoot: string;
  filePath: string;
  kind: "source" | "markdown";
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  selectedText: string;
  beforeContext: string;
  afterContext: string;
  body: string;
}

export interface RemoteEndCommentSessionResult {
  session: RemoteCommentSession | null;
  exportPath?: string;
}

export interface RemoteCommentExportResult {
  exportPath: string;
  payload: unknown;
}
