/** Mirror of preload bridge types for the renderer (no Electron imports). */

export type HostKind = "local" | "wsl" | "ssh";

export interface AppVersionInfo {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  hostId: string;
  hostKind: HostKind;
}

export interface HostInfo {
  id: string;
  kind: HostKind;
  profileId: string;
  workspaceRoot: string | null;
}

export interface HostProfile {
  id: string;
  kind: HostKind;
  label?: string;
  ssh?: {
    host: string;
    port?: number;
    username: string;
    privateKeyPath?: string;
  };
  wsl?: {
    distro?: string;
    user?: string;
  };
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface StatResult {
  isFile: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface RecentWorkspace {
  path: string;
  hostProfileId: string;
  lastOpenedAt: string;
}

export interface ReadTextResult {
  text: string;
  size: number;
  truncated: boolean;
}

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

export interface DiffFile {
  path: string;
  status: string;
}

export interface DiffOpenPayload {
  repoRoot: string;
  base: string;
  head: string | "worktree";
  title: string;
  files: DiffFile[];
}

export interface FileDiffContent {
  path: string;
  oldText: string;
  newText: string;
  status: string;
}

export interface StatusEntry {
  path: string;
  status: string;
  code: string;
}

export interface RepoStatus {
  repoRoot: string;
  entries: StatusEntry[];
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
}

export interface HistoryCompareEntry {
  id: string;
  repoRoot: string;
  repoName: string;
  base: string;
  head: string | "worktree";
  label: string;
  createdAt: string;
}

export type TerminalSessionKind = "shell" | "agent";
export type TerminalTitleSource = "default" | "user" | "inferred";

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
  kind: TerminalSessionKind;
  agentId?: string;
  titleSource?: TerminalTitleSource;
}

export interface AgentModelOption {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
  hidden?: boolean;
}

export interface AgentLaunchDiscovery {
  profileId: string;
  supportsModel: boolean;
  supportsEffort: boolean;
  models: AgentModelOption[];
  defaultModel?: string;
  defaultEffort?: string;
  configHome?: string;
  source?: string;
  error?: string;
  fetchedAt?: string;
  cached?: boolean;
}

export interface AgentCliProfile {
  id: string;
  name: string;
  command: string;
  args?: string[];
  detected?: boolean;
  enabled?: boolean;
}

export interface CommentMessage {
  id: string;
  author: string;
  created_at: string;
  body: string;
}

export interface CommentTarget {
  file_path: string;
  kind: "source" | "markdown";
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  selected_text: string;
  before_context: string;
  after_context: string;
  line_text?: string;
}

export interface CommentRecord {
  id: string;
  status: "discussing" | "need_modify" | "closed";
  target: CommentTarget;
  created_at: string;
  updated_at: string;
  author: string;
  messages: CommentMessage[];
}

export interface SessionRecord {
  version: 1;
  id: string;
  title: string;
  status: "active" | "closed";
  created_at: string;
  ended_at: string | null;
  author: string;
  notes: string;
  comments: CommentRecord[];
  filePath?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: "active" | "closed";
  created_at: string;
  ended_at: string | null;
  commentCount: number;
  filePath?: string;
}

export interface AddCommentInput {
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
  lineText?: string;
  body: string;
  author?: string;
}

export interface AnchReviewExportPayload {
  session: {
    id: string;
    title: string;
    status: string;
    actor: string;
    authorId: string;
    workspaceRoot: string;
    createdAt: string;
    stoppedAt: string | null;
  };
  entries: Array<Record<string, unknown>>;
}

export interface AnchorApi {
  shell: {
    getVersion: () => Promise<AppVersionInfo>;
    onCommand: (cb: (cmd: { type: string }) => void) => () => void;
  };
  host: {
    getInfo: () => Promise<HostInfo>;
    listProfiles: () => Promise<HostProfile[]>;
    listWslDistros: () => Promise<string[]>;
    wslHome: (args?: { distro?: string }) => Promise<string>;
    browseListDir: (args: {
      path: string;
      kind: "wsl" | "ssh";
      distro?: string;
    }) => Promise<DirEntry[]>;
    useProfile: (
      profileId: string,
    ) => Promise<{ id: string; kind: HostKind; profileId: string }>;
    upsertProfile: (profile: HostProfile) => Promise<HostProfile[]>;
  };
  clipboard: {
    writeText: (text: string) => Promise<boolean>;
  };
  workspace: {
    pickFolder: () => Promise<string | null>;
    pickFile: () => Promise<string | null>;
    open: (
      pathOrArgs: string | { path: string; hostProfileId?: string },
    ) => Promise<{
      root: string;
      name: string;
      hostKind: HostKind;
      hostProfileId: string;
    }>;
    getRecent: () => Promise<RecentWorkspace[]>;
    listDir: (path: string) => Promise<DirEntry[]>;
    readText: (path: string) => Promise<ReadTextResult>;
    stat: (path: string) => Promise<StatResult>;
    findFiles: (args?: {
      root?: string;
      maxFiles?: number;
    }) => Promise<{
      root: string;
      files: string[];
      truncated: boolean;
      source?: "git" | "walk";
    }>;
  };
  history: {
    discover: (workspaceRoot: string) => Promise<RepoInfo[]>;
    loadLog: (repoRoot: string) => Promise<CommitRow[]>;
    status: (repoRoot: string) => Promise<RepoStatus>;
    compare: (args: {
      repoRoot: string;
      base: string;
      head: string | "worktree";
    }) => Promise<DiffOpenPayload>;
    getFileDiff: (args: {
      repoRoot: string;
      base: string;
      head: string | "worktree";
      path: string;
      status: string;
    }) => Promise<FileDiffContent>;
    getRecentCompares: (workspaceRoot: string) => Promise<HistoryCompareEntry[]>;
    pushRecentCompare: (args: {
      workspaceRoot: string;
      entry: HistoryCompareEntry;
    }) => Promise<HistoryCompareEntry[]>;
    removeRecentCompare: (args: {
      workspaceRoot: string;
      id: string;
    }) => Promise<HistoryCompareEntry[]>;
  };
  annotations: {
    locateGitRoot: (filePath: string) => Promise<string | null>;
    load: (
      repoRoot: string,
    ) => Promise<{ sessions: SessionRecord[]; error?: string }>;
    list: (
      repoRoot: string,
    ) => Promise<{ sessions: SessionSummary[]; error?: string }>;
    ensureActive: (
      args: string | { repoRoot: string; title?: string },
    ) => Promise<SessionRecord>;
    addComment: (input: AddCommentInput) => Promise<SessionRecord>;
    setStatus: (args: {
      repoRoot: string;
      commentId: string;
      status: CommentRecord["status"];
    }) => Promise<SessionRecord>;
    reply: (args: {
      repoRoot: string;
      commentId: string;
      body: string;
    }) => Promise<SessionRecord>;
    editComment: (args: {
      repoRoot: string;
      commentId: string;
      body: string;
      messageId?: string;
    }) => Promise<SessionRecord>;
    deleteComment: (args: {
      repoRoot: string;
      commentId: string;
    }) => Promise<SessionRecord>;
    endSession: (
      args: string | { repoRoot: string; sessionId?: string; export?: boolean },
    ) => Promise<{ session: SessionRecord | null; exportPath?: string }>;
    newSession: (
      args: string | { repoRoot: string; title?: string },
    ) => Promise<SessionRecord>;
    restoreSession: (args: {
      repoRoot: string;
      sessionId: string;
    }) => Promise<SessionRecord>;
    exportSession: (args: {
      repoRoot: string;
      sessionId?: string;
    }) => Promise<{ exportPath: string; payload: AnchReviewExportPayload }>;
    copyYamlPath: (
      args: string | { repoRoot: string; sessionId?: string },
    ) => Promise<string>;
  };
  terminal: {
    create: (args?: {
      cwd?: string;
      cols?: number;
      rows?: number;
      kind?: TerminalSessionKind;
      command?: string;
      args?: string[];
      title?: string;
      agentId?: string;
    }) => Promise<TerminalTabInfo>;
    list: () => Promise<TerminalTabInfo[]>;
    rename: (id: string, title: string) => Promise<TerminalTabInfo>;
    applyTitle: (id: string, title: string) => Promise<TerminalTabInfo>;
    applyAgentTopic: (id: string, line: string) => Promise<TerminalTabInfo>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    kill: (id: string) => Promise<void>;
    disposeAll: () => Promise<void>;
    onData: (
      cb: (payload: { id: string; data: string }) => void,
    ) => () => void;
    onTitle: (
      cb: (payload: { id: string; info: TerminalTabInfo }) => void,
    ) => () => void;
    onExit: (
      cb: (payload: {
        id: string;
        exitCode: number;
        kind?: TerminalSessionKind;
      }) => void,
    ) => () => void;
  };
  agent: {
    listProfiles: () => Promise<AgentCliProfile[]>;
    detect: () => Promise<AgentCliProfile[]>;
    saveProfiles: (profiles: AgentCliProfile[]) => Promise<AgentCliProfile[]>;
    upsertProfile: (profile: AgentCliProfile) => Promise<AgentCliProfile[]>;
    getDefaultId: () => Promise<string | undefined>;
    setDefaultId: (id: string | null | undefined) => Promise<void>;
    discoverLaunch: (
      profileId: string | { profileId: string; force?: boolean },
    ) => Promise<AgentLaunchDiscovery>;
    buildLaunchArgs: (args: {
      profileId: string;
      model?: string;
      effort?: string;
      prompt?: string;
    }) => Promise<string[]>;
  };
}
