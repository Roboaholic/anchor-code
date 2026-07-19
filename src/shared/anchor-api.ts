/** Mirror of preload bridge types for the renderer (no Electron imports). */

export interface AppVersionInfo {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  hostId: string;
  hostKind: "local" | "ssh";
}

export interface HostInfo {
  id: string;
  kind: "local" | "ssh";
  workspaceRoot: string | null;
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

export interface TerminalTabInfo {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
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
  body: string;
  author?: string;
}

export interface AnchorApi {
  shell: {
    getVersion: () => Promise<AppVersionInfo>;
  };
  host: {
    getInfo: () => Promise<HostInfo>;
  };
  clipboard: {
    writeText: (text: string) => Promise<boolean>;
  };
  workspace: {
    pickFolder: () => Promise<string | null>;
    open: (path: string) => Promise<{ root: string; name: string }>;
    getRecent: () => Promise<RecentWorkspace[]>;
    listDir: (path: string) => Promise<DirEntry[]>;
    readText: (path: string) => Promise<ReadTextResult>;
    stat: (path: string) => Promise<StatResult>;
  };
  history: {
    discover: (workspaceRoot: string) => Promise<RepoInfo[]>;
    loadLog: (repoRoot: string) => Promise<CommitRow[]>;
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
  };
  annotations: {
    locateGitRoot: (filePath: string) => Promise<string | null>;
    load: (
      repoRoot: string,
    ) => Promise<{ sessions: SessionRecord[]; error?: string }>;
    ensureActive: (repoRoot: string) => Promise<SessionRecord>;
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
    endSession: (repoRoot: string) => Promise<SessionRecord | null>;
    newSession: (repoRoot: string) => Promise<SessionRecord>;
    copyYamlPath: (repoRoot: string) => Promise<string>;
  };
  terminal: {
    create: (args?: {
      cwd?: string;
      cols?: number;
      rows?: number;
    }) => Promise<TerminalTabInfo>;
    list: () => Promise<TerminalTabInfo[]>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    kill: (id: string) => Promise<void>;
    disposeAll: () => Promise<void>;
    onData: (
      cb: (payload: { id: string; data: string }) => void,
    ) => () => void;
    onExit: (
      cb: (payload: { id: string; exitCode: number }) => void,
    ) => () => void;
  };
}
