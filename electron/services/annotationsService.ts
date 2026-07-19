import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LocalHostSession } from "../host/localHost.js";
import { HostError } from "../host/types.js";

export type SessionStatus = "active" | "closed";
export type CommentStatus = "discussing" | "need_modify" | "closed";
export type TargetKind = "source" | "markdown";

export interface CommentMessage {
  id: string;
  author: string;
  created_at: string;
  body: string;
}

export interface CommentTarget {
  file_path: string;
  kind: TargetKind;
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
  status: CommentStatus;
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
  status: SessionStatus;
  created_at: string;
  ended_at: string | null;
  author: string;
  notes: string;
  comments: CommentRecord[];
  /** Absolute path to YAML on disk */
  filePath?: string;
}

export interface AddCommentInput {
  repoRoot: string;
  filePath: string; // absolute or relative — we store relative to repo
  kind: TargetKind;
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

function sessionDir(repoRoot: string): string {
  return path.join(repoRoot, ".anchor-code");
}

function sessionFilePath(repoRoot: string, sessionId: string): string {
  return path.join(sessionDir(repoRoot), `${sessionId}.yaml`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${rand}`;
}

function asRelative(repoRoot: string, filePath: string): string {
  const r = path.resolve(repoRoot);
  const f = path.resolve(filePath);
  if (f === r) return "";
  if (f.startsWith(r + path.sep)) {
    return f.slice(r.length + 1).split(path.sep).join("/");
  }
  // already relative-ish
  return filePath.replace(/\\/g, "/");
}

export async function locateGitRoot(
  host: LocalHostSession,
  startPath: string,
): Promise<string | null> {
  let current = path.resolve(startPath);
  try {
    const st = await host.stat(current);
    if (st.isFile) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  for (let i = 0; i < 40; i++) {
    const git = path.join(current, ".git");
    if (await host.exists(git)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function validateSession(raw: unknown): SessionRecord {
  if (!raw || typeof raw !== "object") {
    throw new HostError("failed", "Invalid session YAML");
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) {
    throw new HostError("failed", "Unsupported session version");
  }
  if (typeof o.id !== "string" || typeof o.status !== "string") {
    throw new HostError("failed", "Session missing id/status");
  }
  return {
    version: 1,
    id: o.id,
    title: typeof o.title === "string" ? o.title : "HITL review",
    status: o.status as SessionStatus,
    created_at: String(o.created_at ?? nowIso()),
    ended_at: (o.ended_at as string | null) ?? null,
    author: typeof o.author === "string" ? o.author : "local-user",
    notes: typeof o.notes === "string" ? o.notes : "",
    comments: Array.isArray(o.comments)
      ? (o.comments as CommentRecord[])
      : [],
  };
}

async function listSessionFiles(
  host: LocalHostSession,
  repoRoot: string,
): Promise<string[]> {
  const dir = sessionDir(repoRoot);
  if (!(await host.exists(dir))) return [];
  const entries = await host.listDir(dir);
  return entries
    .filter((e) => e.type === "file" && e.name.endsWith(".yaml"))
    .map((e) => path.join(dir, e.name));
}

export async function loadSessions(
  host: LocalHostSession,
  repoRoot: string,
): Promise<{ sessions: SessionRecord[]; error?: string }> {
  try {
    const files = await listSessionFiles(host, repoRoot);
    const sessions: SessionRecord[] = [];
    for (const file of files) {
      try {
        const text = await host.readFile(file);
        const parsed = validateSession(parseYaml(text));
        parsed.filePath = file;
        sessions.push(parsed);
      } catch (err) {
        return {
          sessions: [],
          error:
            err instanceof Error
              ? `Failed to parse ${path.basename(file)}: ${err.message}`
              : String(err),
        };
      }
    }
    return { sessions };
  } catch (err) {
    return {
      sessions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function ensureActiveSession(
  host: LocalHostSession,
  repoRoot: string,
  author = "local-user",
): Promise<SessionRecord> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) {
    throw new HostError("failed", error);
  }
  const actives = sessions.filter((s) => s.status === "active");
  if (actives.length > 1) {
    throw new HostError(
      "failed",
      "Multiple active sessions found. Keep one active in .anchor-code/ YAML.",
    );
  }
  if (actives.length === 1) {
    return actives[0]!;
  }
  const id = makeId("session");
  const session: SessionRecord = {
    version: 1,
    id,
    title: "HITL review",
    status: "active",
    created_at: nowIso(),
    ended_at: null,
    author,
    notes: "",
    comments: [],
  };
  await writeSession(host, repoRoot, session);
  session.filePath = sessionFilePath(repoRoot, id);
  return session;
}

async function writeSession(
  host: LocalHostSession,
  repoRoot: string,
  session: SessionRecord,
): Promise<string> {
  const dir = sessionDir(repoRoot);
  await host.mkdirp(dir);
  const filePath = sessionFilePath(repoRoot, session.id);
  const toWrite = {
    version: session.version,
    id: session.id,
    title: session.title,
    status: session.status,
    created_at: session.created_at,
    ended_at: session.ended_at,
    author: session.author,
    notes: session.notes,
    comments: session.comments,
  };
  const yaml = stringifyYaml(toWrite, { lineWidth: 0 });
  await host.writeFile(filePath, yaml);
  return filePath;
}

export async function addComment(
  host: LocalHostSession,
  input: AddCommentInput,
): Promise<SessionRecord> {
  const session = await ensureActiveSession(
    host,
    input.repoRoot,
    input.author ?? "local-user",
  );
  if (session.status !== "active") {
    throw new HostError("failed", "No active session to write comments");
  }
  const ts = nowIso();
  const comment: CommentRecord = {
    id: makeId("comment"),
    status: "discussing",
    target: {
      file_path: asRelative(input.repoRoot, input.filePath),
      kind: input.kind,
      start_line: input.startLine,
      end_line: input.endLine,
      start_column: input.startColumn,
      end_column: input.endColumn,
      selected_text: input.selectedText,
      before_context: input.beforeContext,
      after_context: input.afterContext,
    },
    created_at: ts,
    updated_at: ts,
    author: input.author ?? "local-user",
    messages: [
      {
        id: makeId("message"),
        author: input.author ?? "local-user",
        created_at: ts,
        body: input.body,
      },
    ],
  };
  session.comments = [...session.comments, comment];
  const filePath = await writeSession(host, input.repoRoot, session);
  session.filePath = filePath;
  return session;
}

export async function setCommentStatus(
  host: LocalHostSession,
  repoRoot: string,
  commentId: string,
  status: CommentStatus,
): Promise<SessionRecord> {
  const session = await ensureActiveSession(host, repoRoot);
  const idx = session.comments.findIndex((c) => c.id === commentId);
  if (idx < 0) throw new HostError("not_found", "Comment not found");
  const c = session.comments[idx]!;
  session.comments[idx] = {
    ...c,
    status,
    updated_at: nowIso(),
  };
  const filePath = await writeSession(host, repoRoot, session);
  session.filePath = filePath;
  return session;
}

export async function replyComment(
  host: LocalHostSession,
  repoRoot: string,
  commentId: string,
  body: string,
  author = "local-user",
): Promise<SessionRecord> {
  const session = await ensureActiveSession(host, repoRoot, author);
  const idx = session.comments.findIndex((c) => c.id === commentId);
  if (idx < 0) throw new HostError("not_found", "Comment not found");
  const c = session.comments[idx]!;
  const msg: CommentMessage = {
    id: makeId("message"),
    author,
    created_at: nowIso(),
    body,
  };
  session.comments[idx] = {
    ...c,
    messages: [...c.messages, msg],
    updated_at: nowIso(),
  };
  const filePath = await writeSession(host, repoRoot, session);
  session.filePath = filePath;
  return session;
}

export async function endSession(
  host: LocalHostSession,
  repoRoot: string,
): Promise<SessionRecord | null> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) throw new HostError("failed", error);
  const active = sessions.find((s) => s.status === "active");
  if (!active) return null;
  active.status = "closed";
  active.ended_at = nowIso();
  const filePath = await writeSession(host, repoRoot, active);
  active.filePath = filePath;
  return active;
}

export async function newSession(
  host: LocalHostSession,
  repoRoot: string,
  author = "local-user",
): Promise<SessionRecord> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) throw new HostError("failed", error);
  if (sessions.some((s) => s.status === "active")) {
    throw new HostError(
      "failed",
      "End the active session before creating a new one",
    );
  }
  return ensureActiveSession(host, repoRoot, author);
}

export async function copyYamlPath(
  host: LocalHostSession,
  repoRoot: string,
): Promise<string> {
  const session = await ensureActiveSession(host, repoRoot);
  const abs = session.filePath ?? sessionFilePath(repoRoot, session.id);
  return abs;
}
