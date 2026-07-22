import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseSession,
  selectActiveSession,
  toRepoRelative,
  type SessionParsed,
} from "../../src/core/annotations/sessionSchema.js";
import {
  buildAnchReviewExport,
  type AnchReviewExportPayload,
} from "../../src/core/annotations/exportFormat.js";
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
  line_text?: string;
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

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  ended_at: string | null;
  commentCount: number;
  filePath?: string;
}

export interface AddCommentInput {
  repoRoot: string;
  filePath: string;
  kind: TargetKind;
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

function sessionDir(repoRoot: string): string {
  return path.join(repoRoot, ".anchor-code");
}

function exportDir(repoRoot: string): string {
  return path.join(sessionDir(repoRoot), "exports");
}

function sessionFilePath(repoRoot: string, sessionId: string): string {
  return path.join(sessionDir(repoRoot), `${sessionId}.yaml`);
}

function exportFilePath(repoRoot: string, sessionId: string): string {
  return path.join(exportDir(repoRoot), `${sessionId}.json`);
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
  return toRepoRelative(r, f);
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
  try {
    const parsed: SessionParsed = parseSession(raw);
    return {
      version: 1,
      id: parsed.id,
      title: parsed.title,
      status: parsed.status,
      created_at: parsed.created_at,
      ended_at: parsed.ended_at,
      author: parsed.author,
      notes: parsed.notes,
      comments: parsed.comments as CommentRecord[],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HostError("failed", `Invalid session YAML: ${message}`);
  }
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
    sessions.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { sessions };
  } catch (err) {
    return {
      sessions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listSessionSummaries(
  host: LocalHostSession,
  repoRoot: string,
): Promise<{ sessions: SessionSummary[]; error?: string }> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  return {
    error,
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      created_at: s.created_at,
      ended_at: s.ended_at,
      commentCount: s.comments.length,
      filePath: s.filePath,
    })),
  };
}

async function loadSessionById(
  host: LocalHostSession,
  repoRoot: string,
  sessionId: string,
): Promise<SessionRecord> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) throw new HostError("failed", error);
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) throw new HostError("not_found", `Session not found: ${sessionId}`);
  return found;
}

async function requireActiveSession(
  host: LocalHostSession,
  repoRoot: string,
  author = "local-user",
): Promise<SessionRecord> {
  const session = await ensureActiveSession(host, repoRoot, author);
  if (session.status !== "active") {
    throw new HostError("failed", "No active session");
  }
  return session;
}

export async function ensureActiveSession(
  host: LocalHostSession,
  repoRoot: string,
  author = "local-user",
  title?: string,
): Promise<SessionRecord> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) {
    throw new HostError("failed", error);
  }
  let active: SessionRecord | null;
  try {
    active = selectActiveSession(sessions);
  } catch (err) {
    throw new HostError(
      "failed",
      err instanceof Error ? err.message : String(err),
    );
  }
  if (active) {
    return active;
  }
  const id = makeId("session");
  const session: SessionRecord = {
    version: 1,
    id,
    title: title?.trim() || `Review ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
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
  const session = await requireActiveSession(
    host,
    input.repoRoot,
    input.author ?? "local-user",
  );
  const ts = nowIso();
  const selected = input.selectedText;
  const lineText =
    input.lineText ??
    selected.split(/\r?\n/)[0] ??
    "";
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
      selected_text: selected,
      before_context: input.beforeContext,
      after_context: input.afterContext,
      line_text: lineText,
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
  const session = await requireActiveSession(host, repoRoot);
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
  if (!body.trim()) {
    throw new HostError("failed", "Reply body cannot be empty");
  }
  const session = await requireActiveSession(host, repoRoot, author);
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

/** Edit primary message body (or a specific message by id). */
export async function editComment(
  host: LocalHostSession,
  repoRoot: string,
  commentId: string,
  body: string,
  messageId?: string,
): Promise<SessionRecord> {
  if (!body.trim()) {
    throw new HostError("failed", "Comment body cannot be empty");
  }
  const session = await requireActiveSession(host, repoRoot);
  const idx = session.comments.findIndex((c) => c.id === commentId);
  if (idx < 0) throw new HostError("not_found", "Comment not found");
  const c = session.comments[idx]!;
  const msgIdx = messageId
    ? c.messages.findIndex((m) => m.id === messageId)
    : 0;
  if (msgIdx < 0) throw new HostError("not_found", "Message not found");
  const messages = c.messages.map((m, i) =>
    i === msgIdx ? { ...m, body } : m,
  );
  session.comments[idx] = {
    ...c,
    messages,
    updated_at: nowIso(),
  };
  const filePath = await writeSession(host, repoRoot, session);
  session.filePath = filePath;
  return session;
}

export async function deleteComment(
  host: LocalHostSession,
  repoRoot: string,
  commentId: string,
): Promise<SessionRecord> {
  const session = await requireActiveSession(host, repoRoot);
  const before = session.comments.length;
  session.comments = session.comments.filter((c) => c.id !== commentId);
  if (session.comments.length === before) {
    throw new HostError("not_found", "Comment not found");
  }
  const filePath = await writeSession(host, repoRoot, session);
  session.filePath = filePath;
  return session;
}

export async function endSession(
  host: LocalHostSession,
  repoRoot: string,
  options?: { export?: boolean; sessionId?: string },
): Promise<{ session: SessionRecord | null; exportPath?: string }> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) throw new HostError("failed", error);
  const active = options?.sessionId
    ? sessions.find((s) => s.id === options.sessionId)
    : sessions.find((s) => s.status === "active");
  if (!active) return { session: null };
  if (active.status === "active") {
    active.status = "closed";
    active.ended_at = nowIso();
  }
  const filePath = await writeSession(host, repoRoot, active);
  active.filePath = filePath;

  let exportPath: string | undefined;
  if (options?.export !== false) {
    const result = await exportSession(host, repoRoot, active.id);
    exportPath = result.exportPath;
  }
  return { session: active, exportPath };
}

export async function newSession(
  host: LocalHostSession,
  repoRoot: string,
  author = "local-user",
  title?: string,
): Promise<SessionRecord> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) throw new HostError("failed", error);
  if (sessions.some((s) => s.status === "active")) {
    throw new HostError(
      "failed",
      "End the active session before creating a new one",
    );
  }
  return ensureActiveSession(host, repoRoot, author, title);
}

/**
 * Restore a closed session as the sole active one.
 * Closes any other active session first.
 */
export async function restoreSession(
  host: LocalHostSession,
  repoRoot: string,
  sessionId: string,
): Promise<SessionRecord> {
  const { sessions, error } = await loadSessions(host, repoRoot);
  if (error) throw new HostError("failed", error);
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) throw new HostError("not_found", `Session not found: ${sessionId}`);

  for (const s of sessions) {
    if (s.id !== sessionId && s.status === "active") {
      s.status = "closed";
      s.ended_at = s.ended_at ?? nowIso();
      await writeSession(host, repoRoot, s);
    }
  }

  target.status = "active";
  target.ended_at = null;
  const filePath = await writeSession(host, repoRoot, target);
  target.filePath = filePath;
  return target;
}

export async function copyYamlPath(
  host: LocalHostSession,
  repoRoot: string,
  sessionId?: string,
): Promise<string> {
  if (sessionId) {
    const session = await loadSessionById(host, repoRoot, sessionId);
    return session.filePath ?? sessionFilePath(repoRoot, session.id);
  }
  const session = await requireActiveSession(host, repoRoot);
  return session.filePath ?? sessionFilePath(repoRoot, session.id);
}

async function collectExportMeta(
  host: LocalHostSession,
  repoRoot: string,
  session: SessionRecord,
): Promise<
  Record<string, { fileHash?: string | null; gitCommitSha?: string | null }>
> {
  const meta: Record<
    string,
    { fileHash?: string | null; gitCommitSha?: string | null }
  > = {};
  let gitCommitSha: string | null = null;
  try {
    const result = await host.run(repoRoot, "git", ["rev-parse", "HEAD"]);
    if (result.code === 0) {
      gitCommitSha = result.stdout.trim() || null;
    }
  } catch {
    gitCommitSha = null;
  }

  const paths = new Set(
    session.comments.map((c) => c.target.file_path.replace(/\\/g, "/")),
  );
  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    let fileHash: string | null = null;
    try {
      if (await host.exists(abs)) {
        const text = await host.readFile(abs);
        fileHash = createHash("sha256").update(text, "utf8").digest("hex");
      }
    } catch {
      fileHash = null;
    }
    meta[rel] = { fileHash, gitCommitSha };
  }
  return meta;
}

export async function exportSession(
  host: LocalHostSession,
  repoRoot: string,
  sessionId?: string,
): Promise<{ exportPath: string; payload: AnchReviewExportPayload }> {
  let session: SessionRecord;
  if (sessionId) {
    session = await loadSessionById(host, repoRoot, sessionId);
  } else {
    session = await requireActiveSession(host, repoRoot);
  }

  const meta = await collectExportMeta(host, repoRoot, session);
  const payload = buildAnchReviewExport(session, repoRoot, meta);

  const outDir = exportDir(repoRoot);
  await host.mkdirp(outDir);
  const outPath = exportFilePath(repoRoot, session.id);
  const json = JSON.stringify(payload, null, 2) + "\n";
  await host.writeFile(outPath, json);
  return { exportPath: outPath, payload };
}
