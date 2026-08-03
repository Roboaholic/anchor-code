import type {
  RemoteAgentProfile,
  RemoteAgentLaunchOptions,
  RemoteBootstrap,
  RemoteCommentRecord,
  RemoteCommentSession,
  RemoteCommit,
  RemoteDiffFile,
  RemoteDirEntry,
  RemoteFileDiff,
  RemoteFileIndex,
  RemoteRepoStatus,
  RemoteSearchHit,
  RemoteApplicationEvent,
  RemoteTerminalEvent,
  RemoteTerminalInfo,
  RemoteWorkspaceCatalog,
  RemoteEndCommentSessionResult,
  RemoteCommentExportResult,
} from "../../../contracts/remote-api/v1/index.js";

type RecordLike = Record<string, unknown>;

function object(value: unknown): RecordLike {
  return value && typeof value === "object" ? value as RecordLike : {};
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number { return typeof value === "number" ? value : 0; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

export function toRemoteTerminalInfo(value: unknown): RemoteTerminalInfo {
  const item = object(value);
  return {
    id: text(item.id),
    title: text(item.title),
    cwd: text(item.cwd),
    status: item.status === "exited" ? "exited" : "running",
    kind: item.kind === "agent" ? "agent" : "shell",
    ...(optionalText(item.agentId) ? { agentId: optionalText(item.agentId) } : {}),
    ...(item.titleSource === "default" || item.titleSource === "user" || item.titleSource === "inferred"
      ? { titleSource: item.titleSource }
      : {}),
  };
}

export function toRemoteAgentProfile(value: unknown): RemoteAgentProfile {
  const item = object(value);
  return {
    id: text(item.id),
    name: text(item.name),
    command: text(item.command),
    ...(Array.isArray(item.args) ? { args: item.args.filter((arg): arg is string => typeof arg === "string") } : {}),
    ...(typeof item.detected === "boolean" ? { detected: item.detected } : {}),
    ...(typeof item.enabled === "boolean" ? { enabled: item.enabled } : {}),
  };
}

export function toRemoteAgentLaunchOptions(value: unknown): RemoteAgentLaunchOptions {
  const item = object(value);
  return {
    profileId: text(item.profileId),
    supportsModel: item.supportsModel === true,
    supportsEffort: item.supportsEffort === true,
    models: (Array.isArray(item.models) ? item.models : []).map((model) => {
      const option = object(model);
      return {
        id: text(option.id),
        label: text(option.label),
        efforts: (Array.isArray(option.efforts) ? option.efforts : []).filter((effort): effort is string => typeof effort === "string"),
        ...(optionalText(option.defaultEffort) ? { defaultEffort: optionalText(option.defaultEffort) } : {}),
        ...(typeof option.hidden === "boolean" ? { hidden: option.hidden } : {}),
      };
    }),
    ...(optionalText(item.defaultModel) ? { defaultModel: optionalText(item.defaultModel) } : {}),
    ...(optionalText(item.defaultEffort) ? { defaultEffort: optionalText(item.defaultEffort) } : {}),
    ...(optionalText(item.source) ? { source: optionalText(item.source) } : {}),
    ...(optionalText(item.error) ? { error: optionalText(item.error) } : {}),
    ...(typeof item.cached === "boolean" ? { cached: item.cached } : {}),
  };
}

export function toRemoteWorkspaceCatalog(value: unknown): RemoteWorkspaceCatalog {
  const catalog = object(value);
  const active = object(catalog.active);
  return {
    active: text(active.path) && text(active.hostProfileId)
      ? { path: text(active.path), hostProfileId: text(active.hostProfileId) }
      : null,
    recent: (Array.isArray(catalog.recent) ? catalog.recent : []).map((entry) => {
      const item = object(entry);
      return {
        path: text(item.path),
        hostProfileId: text(item.hostProfileId),
        lastOpenedAt: text(item.lastOpenedAt),
        name: text(item.name),
        hostKind: text(item.hostKind),
        hostLabel: text(item.hostLabel),
      };
    }),
  };
}

export function toRemoteDirEntries(value: unknown): RemoteDirEntry[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const item = object(entry);
    return { name: text(item.name), type: item.type === "dir" ? "dir" : "file" };
  });
}

export function toRemoteRepos(value: unknown): Array<{ root: string; name: string }> {
  return (Array.isArray(value) ? value : []).map((repo) => {
    const item = object(repo);
    return { root: text(item.root), name: text(item.name) };
  });
}

export function toRemoteFileIndex(value: unknown): RemoteFileIndex {
  const item = object(value);
  return {
    root: text(item.root),
    files: (Array.isArray(item.files) ? item.files : []).filter((file): file is string => typeof file === "string"),
    truncated: item.truncated === true,
    source: item.source === "git" || item.source === "multi-git" ? item.source : "walk",
  };
}

export function toRemoteCommit(value: unknown): RemoteCommit {
  const item = object(value);
  return {
    hash: text(item.hash),
    shortHash: text(item.shortHash),
    subject: text(item.subject),
    author: text(item.author),
    dateIso: text(item.dateIso),
  };
}

export function toRemoteDiffFile(value: unknown): RemoteDiffFile {
  const item = object(value);
  return { path: text(item.path), status: text(item.status) };
}

export function toRemoteRepoStatus(value: unknown): RemoteRepoStatus {
  const item = object(value);
  return {
    ...(optionalText(item.repoRoot) ? { repoRoot: optionalText(item.repoRoot) } : {}),
    entries: (Array.isArray(item.entries) ? item.entries : []).map((entry) => {
      const status = object(entry);
      return { path: text(status.path), status: text(status.status), code: text(status.code) };
    }),
    modified: number(item.modified),
    added: number(item.added),
    deleted: number(item.deleted),
    untracked: number(item.untracked),
    branch: typeof item.branch === "string" ? item.branch : null,
    ahead: typeof item.ahead === "number" ? item.ahead : null,
    behind: typeof item.behind === "number" ? item.behind : null,
  };
}

export function toRemoteFileDiff(value: unknown): RemoteFileDiff {
  const item = object(value);
  return {
    path: text(item.path),
    oldText: text(item.oldText),
    newText: text(item.newText),
    status: text(item.status),
  };
}

export function toRemoteSearchHits(value: unknown): RemoteSearchHit[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const item = object(entry);
    return { path: text(item.path), line: number(item.line), text: text(item.text) };
  });
}

export function toRemoteComment(value: unknown): RemoteCommentRecord {
  const item = object(value);
  const target = object(item.target);
  return {
    id: text(item.id),
    status: item.status === "need_modify" || item.status === "closed" ? item.status : "discussing",
    target: {
      file_path: text(target.file_path),
      kind: target.kind === "markdown" ? "markdown" : "source",
      start_line: number(target.start_line),
      end_line: number(target.end_line),
      start_column: number(target.start_column),
      end_column: number(target.end_column),
      selected_text: text(target.selected_text),
      before_context: text(target.before_context),
      after_context: text(target.after_context),
    },
    created_at: text(item.created_at),
    updated_at: text(item.updated_at),
    author: text(item.author),
    messages: (Array.isArray(item.messages) ? item.messages : []).map((message) => {
      const row = object(message);
      return {
        id: text(row.id),
        author: text(row.author),
        body: text(row.body),
        created_at: text(row.created_at),
      };
    }),
  };
}

export function toRemoteCommentSession(value: unknown): RemoteCommentSession {
  const item = object(value);
  return {
    version: 1,
    id: text(item.id),
    title: text(item.title),
    status: item.status === "closed" ? "closed" : "active",
    created_at: text(item.created_at),
    ended_at: typeof item.ended_at === "string" ? item.ended_at : null,
    author: text(item.author),
    notes: text(item.notes),
    ...(optionalText(item.filePath) ? { filePath: optionalText(item.filePath) } : {}),
    comments: (Array.isArray(item.comments) ? item.comments : []).map(toRemoteComment),
  };
}

export function toRemoteEndCommentSession(value: unknown): RemoteEndCommentSessionResult {
  const item = object(value);
  return {
    session: item.session ? toRemoteCommentSession(item.session) : null,
    ...(optionalText(item.exportPath) ? { exportPath: optionalText(item.exportPath) } : {}),
  };
}

export function toRemoteCommentExport(value: unknown): RemoteCommentExportResult {
  const item = object(value);
  return { exportPath: text(item.exportPath), payload: item.payload };
}

export function toRemoteTerminalEvent(value: unknown): RemoteTerminalEvent {
  const event = object(value);
  if (event.type === "created" || event.type === "updated") {
    return { type: event.type, info: toRemoteTerminalInfo(event.info) };
  }
  if (event.type === "data") {
    return { type: "data", id: text(event.id), data: text(event.data), seq: number(event.seq) };
  }
  if (event.type === "exit") {
    return {
      type: "exit",
      id: text(event.id),
      exitCode: number(event.exitCode),
      kind: event.kind === "agent" ? "agent" : "shell",
    };
  }
  return { type: "removed", id: text(event.id), kind: event.kind === "agent" ? "agent" : "shell" };
}

export function toRemoteApplicationEvent(value: unknown): RemoteApplicationEvent {
  const applicationEvent = object(value);
  if (applicationEvent.type === "workspace") {
    const workspace = object(applicationEvent.workspace);
    return {
      type: "workspace",
      workspace: {
        path: text(workspace.path),
        name: text(workspace.name),
        hostProfileId: text(workspace.hostProfileId),
        hostKind: text(workspace.hostKind),
      },
    };
  }
  return toRemoteTerminalEvent(applicationEvent.event ?? value);
}

export function toRemoteBootstrap(input: Omit<RemoteBootstrap, "repos" | "agents" | "terminals"> & {
  repos: unknown[];
  agents: unknown[];
  terminals: unknown[];
}): RemoteBootstrap {
  return {
    ...input,
    repos: input.repos.map((repo) => {
      const item = object(repo);
      return { root: text(item.root), name: text(item.name) };
    }),
    agents: input.agents.map(toRemoteAgentProfile),
    terminals: input.terminals.map(toRemoteTerminalInfo),
  };
}
