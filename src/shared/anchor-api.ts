/** Mirror of preload bridge types for the renderer (no Electron imports). */

export type HostKind = "local" | "wsl" | "ssh";

export type UiTheme = "light" | "light-modern" | "dark" | "dark-modern";

/** Terminal / Agent session tab strip placement. */
export type SessionTabLayout = "side" | "top";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  canInstall: boolean;
  packaged: boolean;
  progress: number | null;
  message: string | null;
  error: string | null;
}

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

export interface RemoteAccessInfo {
  enabled: boolean;
  relay: {
    enabled: boolean;
    state: "disabled" | "connecting" | "online" | "offline";
    url: string;
    roomId: string;
    hostPeerId: string;
    connectedGuests: number;
    devices: Array<{ peerId: string; online: boolean }>;
    pendingDevices: string[];
    error?: string;
    pairing?: {
      v: 1;
      type: "anchor-code-relay";
      relayUrl: string;
      roomId: string;
      hostPeerId: string;
      ticket: string;
      secret: string;
      expiresAt: string;
    };
  };
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
    password?: string;
    knownHostsPolicy?: "accept-new" | "strict" | "ignore";
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

export interface BlameLine {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  dateIso: string;
  subject: string;
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
  /** Current branch at compare time (best-effort). */
  branch?: string | null;
  /** Prefer this file when opening (defaults to files[0]). */
  activeFilePath?: string | null;
  /**
   * Single-file / focus mode: hide the CHANGED FILES sidebar
   * (e.g. clicking a row under History → Changes).
   */
  hideFileList?: boolean;
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
  /** Current branch name; null if detached HEAD. */
  branch: string | null;
  /**
   * Commits ahead of the comparison base (upstream, else origin/HEAD / main / master).
   * null when no base is available.
   */
  ahead: number | null;
  /** Commits behind the same base; null when no base. */
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
  agentSessionId?: string;
  titleSource?: TerminalTitleSource;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
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

export interface SkillInstallTarget {
  id: string;
  kind: "workspace" | "user";
  label: string;
  dir: string;
  skillPath: string;
  installed: boolean;
  upToDate: boolean;
}

export interface SkillInstallStatus {
  skillId: string;
  sourcePath: string | null;
  sourceVersionHint: string | null;
  targets: SkillInstallTarget[];
  workspaceRoot: string | null;
}

export interface SkillInstallResult {
  ok: boolean;
  installed: Array<{ id: string; skillPath: string }>;
  skipped: Array<{ id: string; reason: string }>;
  error?: string;
}

export interface AnchorApi {
  shell: {
    getVersion: () => Promise<AppVersionInfo>;
    menuAction: (action: string) => Promise<boolean>;
    onCommand: (cb: (cmd: { type: string; path?: string; hostProfileId?: string }) => void) => () => void;
  };
  remote: {
    getInfo: () => Promise<RemoteAccessInfo>;
    update: (value: Partial<{
      enabled: boolean;
    }>) => Promise<RemoteAccessInfo>;
    revokeDevice: (peerId: string) => Promise<RemoteAccessInfo>;
    approveDevice: (peerId: string) => Promise<RemoteAccessInfo>;
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
      profileId?: string;
    }) => Promise<DirEntry[]>;
    testProfile: (profileId: string) => Promise<{ ok: true }>;
    useProfile: (
      profileId: string,
    ) => Promise<{ id: string; kind: HostKind; profileId: string }>;
    upsertProfile: (profile: HostProfile) => Promise<HostProfile[]>;
  };
  clipboard: {
    writeText: (text: string) => Promise<boolean>;
    readText: () => Promise<string>;
    hasImage: () => Promise<boolean>;
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
      query?: string;
    }) => Promise<{
      root: string;
      files: string[];
      truncated: boolean;
      source?: "git" | "walk" | "multi-git";
    }>;
    searchContent: (args: {
      root?: string;
      query: string;
      maxResults?: number;
      caseSensitive?: boolean;
      useRegex?: boolean;
      include?: string | string[];
      exclude?: string | string[];
      requestId?: string;
    }) => Promise<{
      root: string;
      query: string;
      hits: { path: string; line: number; text: string }[];
      truncated: boolean;
      source: "git-grep" | "rg" | "scan";
      requestId: string;
    }>;
    /** Streamed hits while searchContent is still running. */
    onSearchHits: (
      cb: (payload: {
        requestId: string;
        hits: { path: string; line: number; text: string }[];
      }) => void,
    ) => () => void;
    onSearchMeta: (
      cb: (payload: {
        requestId: string;
        source: "git-grep" | "rg" | "scan";
      }) => void,
    ) => () => void;
    /** Start watching the workspace root for file changes (local hosts only). */
    watchStart: (root?: string) => Promise<{ ok: boolean }>;
    watchStop: () => Promise<{ ok: boolean }>;
    /** A directory's contents changed (debounced by the main process). */
    onFileChange: (cb: (payload: { dir: string }) => void) => () => void;
    deletePath: (path: string) => Promise<{ ok: boolean }>;
    renamePath: (oldPath: string, newPath: string) => Promise<{ ok: boolean }>;
    copyPath: (src: string, dst: string) => Promise<{ ok: boolean }>;
    createEntry: (
      parentDir: string,
      name: string,
      type: "file" | "dir",
    ) => Promise<{ ok: boolean; path?: string }>;
  };
  history: {
    discover: (workspaceRoot: string) => Promise<RepoInfo[]>;
    loadLog: (repoRoot: string) => Promise<CommitRow[]>;
    fileBlame: (args: {
      repoRoot: string;
      filePath: string;
      revision?: string;
    }) => Promise<BlameLine[]>;
    status: (
      repoRoot: string,
      opts?: { badgeOnly?: boolean },
    ) => Promise<RepoStatus>;
    statusBulk: (args: {
      repoRoots: string[];
      badgeOnly?: boolean;
    }) => Promise<RepoStatus[]>;
    onStatusBulkOne: (cb: (status: RepoStatus) => void) => () => void;
    listBranches: (repoRoot: string) => Promise<BranchInfo[]>;
    checkout: (args: {
      repoRoot: string;
      branch: string;
    }) => Promise<CheckoutResult>;
    commit: (args: {
      repoRoot: string;
      message: string;
      paths?: string[];
    }) => Promise<CommitResult>;
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
      agentSessionId?: string;
    }) => Promise<TerminalTabInfo>;
    list: () => Promise<TerminalTabInfo[]>;
    snapshot: (id: string) => Promise<{ data: string; seq: number }>;
    applyAgentTitle: (id: string, title: string) => Promise<TerminalTabInfo>;
    rename: (id: string, title: string) => Promise<TerminalTabInfo>;
    applyTitle: (id: string, title: string) => Promise<TerminalTabInfo>;
    applyAgentTopic: (id: string, line: string) => Promise<TerminalTabInfo>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    kill: (id: string) => Promise<void>;
    disposeAll: () => Promise<void>;
    onData: (
      cb: (payload: { id: string; data: string; seq: number }) => void,
    ) => () => void;
    onCreated: (
      cb: (payload: { info: TerminalTabInfo }) => void,
    ) => () => void;
    onUpdated: (
      cb: (payload: { info: TerminalTabInfo }) => void,
    ) => () => void;
    onRemoved: (
      cb: (payload: { id: string; kind: TerminalSessionKind }) => void,
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
  settings: {
    getTheme: () => Promise<UiTheme>;
    setTheme: (theme: UiTheme) => Promise<UiTheme>;
    getSessionTabLayout: () => Promise<SessionTabLayout>;
    setSessionTabLayout: (
      layout: SessionTabLayout,
    ) => Promise<SessionTabLayout>;
    getFontSize: () => Promise<number>;
    setFontSize: (fontSize: number) => Promise<number>;
    getUiScale: () => Promise<number>;
    setUiScale: (uiScale: number) => Promise<number>;
  };
  updates: {
    getState: () => Promise<AppUpdateState>;
    check: () => Promise<AppUpdateState>;
    download: () => Promise<AppUpdateState>;
    install: () => Promise<{ ok: boolean; error?: string }>;
    openReleasePage: () => Promise<{ ok: boolean }>;
    onState: (cb: (state: AppUpdateState) => void) => () => void;
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
    listSessions: (args: {
      profileId: string;
      limit?: number;
    }) => Promise<AgentSessionSummary[]>;
    buildLaunchArgs: (args: {
      profileId: string;
      model?: string;
      effort?: string;
      prompt?: string;
    }) => Promise<string[]>;
    createSession: (args: {
      profileId: string;
      model?: string;
      effort?: string;
      prompt?: string;
      resume?: boolean;
      sessionId?: string;
      cols?: number;
      rows?: number;
    }) => Promise<TerminalTabInfo>;
  };
  skill: {
    status: (args?: {
      workspaceRoot?: string | null;
    }) => Promise<SkillInstallStatus>;
    install: (args?: {
      workspaceRoot?: string | null;
      targetIds?: string[];
    }) => Promise<SkillInstallResult>;
    installWorkspace: (workspaceRoot: string) => Promise<SkillInstallResult>;
    isWorkspaceInstalled: (workspaceRoot: string) => Promise<boolean>;
  };
}
