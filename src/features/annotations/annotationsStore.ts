import { create } from "zustand";
import { resolveAnchor } from "@/core/annotations/anchor";
import { commentBodyForDisplay } from "@/core/history/diffComment";
import type {
  CommentRecord,
  SessionRecord,
} from "@/shared/anchor-api";

export interface DecorationSpec {
  commentId: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  hover: string;
  status: CommentRecord["status"];
  anchorStatus: "resolved" | "relocated" | "unresolved";
  overlapCount: number;
}
export interface OverlapRegion {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  depth: number;
}

function rangesOverlap(a: DecorationSpec, b: DecorationSpec): boolean {
  if (a.endLine < b.startLine || b.endLine < a.startLine) return false;
  if (a.startLine === a.endLine && b.startLine === b.endLine) {
    return (
      a.startLine === b.startLine &&
      a.startColumn < b.endColumn &&
      b.startColumn < a.endColumn
    );
  }
  return true;
}

export function overlapRegionsForModel(
  specs: DecorationSpec[],
  lineMaxColumn: (line: number) => number,
): OverlapRegion[] {
  const resolved = specs.filter((spec) => spec.anchorStatus !== "unresolved");
  if (resolved.length < 2) return [];
  const regions: OverlapRegion[] = [];
  const firstLine = Math.min(...resolved.map((spec) => spec.startLine));
  const lastLine = Math.max(...resolved.map((spec) => spec.endLine));

  for (let line = firstLine; line <= lastLine; line += 1) {
    const maxColumn = lineMaxColumn(line);
    const intervals = resolved
      .filter((spec) => line >= spec.startLine && line <= spec.endLine)
      .map((spec) => ({
        start: line === spec.startLine ? spec.startColumn : 1,
        end: line === spec.endLine ? spec.endColumn : maxColumn,
      }))
      .filter((interval) => interval.end > interval.start);
    if (intervals.length < 2) continue;

    const boundaries = Array.from(
      new Set(intervals.flatMap((interval) => [interval.start, interval.end])),
    ).sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const startColumn = boundaries[index]!;
      const endColumn = boundaries[index + 1]!;
      const depth = intervals.filter(
        (interval) => interval.start < endColumn && interval.end > startColumn,
      ).length;
      if (depth < 2) continue;
      regions.push({
        startLine: line,
        endLine: line,
        startColumn,
        endColumn,
        depth,
      });
    }
  }
  return regions;
}

export interface AnnotationsState {
  repoRoot: string | null;
  /** Writable session (status === active), if any. */
  activeSession: SessionRecord | null;
  /** All sessions for the repo, newest first. */
  sessions: SessionRecord[];
  /** Expanded accordion session id. */
  expandedSessionId: string | null;
  error: string | null;
  toast: string | null;
  loading: boolean;

  loadForRepo: (repoRoot: string) => Promise<void>;
  ensureActive: (repoRoot: string, title?: string) => Promise<void>;
  setExpandedSession: (sessionId: string | null) => void;
  addComment: (input: {
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
  }) => Promise<void>;
  setStatus: (
    commentId: string,
    status: CommentRecord["status"],
  ) => Promise<void>;
  reply: (commentId: string, body: string) => Promise<void>;
  editComment: (
    commentId: string,
    body: string,
    messageId?: string,
  ) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  endSession: () => Promise<void>;
  newSession: (title?: string) => Promise<void>;
  /** End active (export) if any, then create a new active session. */
  startFreshSession: (repoRoot: string, title?: string) => Promise<void>;
  restoreSession: (sessionId: string) => Promise<void>;
  exportSession: (sessionId?: string) => Promise<string | null>;
  copyYamlPath: (sessionId?: string) => Promise<string | null>;
  decorationsFor: (absolutePath: string, content: string) => DecorationSpec[];
  clearToast: () => void;
  reset: () => void;
}

function lastMessagePreview(c: CommentRecord): string {
  const last = c.messages[c.messages.length - 1];
  const text = commentBodyForDisplay(last?.body ?? "");
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

function relativeMatch(
  repoRoot: string,
  absolutePath: string,
  filePathRel: string,
): boolean {
  const normAbs = absolutePath.replace(/\\/g, "/").toLowerCase();
  const normRoot = repoRoot
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  const rel = filePathRel.replace(/\\/g, "/").toLowerCase();
  return (
    normAbs === `${normRoot}/${rel}` ||
    normAbs.endsWith(`/${rel}`) ||
    normAbs === rel
  );
}

function sortSessionsNewestFirst(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => {
    // Active first, then by created_at desc.
    if (a.status === "active" && b.status !== "active") return -1;
    if (b.status === "active" && a.status !== "active") return 1;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
}

function pickExpandedId(
  sessions: SessionRecord[],
  preferred?: string | null,
): string | null {
  if (preferred && sessions.some((s) => s.id === preferred)) return preferred;
  const active = sessions.find((s) => s.status === "active");
  if (active) return active.id;
  return sessions[0]?.id ?? null;
}

export function focusedSessionForDecorations(
  sessions: SessionRecord[],
  expandedSessionId: string | null,
  activeSession: SessionRecord | null,
): SessionRecord | null {
  const focusId =
    expandedSessionId ?? activeSession?.id ?? sessions[0]?.id ?? null;
  return sessions.find((session) => session.id === focusId) ?? null;
}

async function reloadSessions(repoRoot: string): Promise<SessionRecord[]> {
  const { sessions, error } = await window.anchor.annotations.load(repoRoot);
  if (error) throw new Error(error);
  return sortSessionsNewestFirst(sessions);
}

function applySessions(
  sessions: SessionRecord[],
  expandedSessionId?: string | null,
): Pick<
  AnnotationsState,
  "sessions" | "activeSession" | "expandedSessionId"
> {
  const sorted = sortSessionsNewestFirst(sessions);
  return {
    sessions: sorted,
    activeSession: sorted.find((s) => s.status === "active") ?? null,
    expandedSessionId: pickExpandedId(sorted, expandedSessionId),
  };
}

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  repoRoot: null,
  activeSession: null,
  sessions: [],
  expandedSessionId: null,
  error: null,
  toast: null,
  loading: false,

  reset: () =>
    set({
      repoRoot: null,
      activeSession: null,
      sessions: [],
      expandedSessionId: null,
      error: null,
      toast: null,
      loading: false,
    }),

  clearToast: () => set({ toast: null }),

  setExpandedSession: (sessionId) => {
    const { sessions } = get();
    if (sessionId && !sessions.some((s) => s.id === sessionId)) return;
    set({ expandedSessionId: sessionId });
  },

  loadForRepo: async (repoRoot) => {
    set({ loading: true, error: null, repoRoot });
    try {
      const sessions = await reloadSessions(repoRoot);
      set({
        ...applySessions(sessions, get().expandedSessionId),
        loading: false,
        error: null,
        repoRoot,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        activeSession: null,
        sessions: [],
        expandedSessionId: null,
      });
    }
  },

  ensureActive: async (repoRoot, title) => {
    set({ loading: true, error: null, repoRoot });
    try {
      const session = await window.anchor.annotations.ensureActive(
        title ? { repoRoot, title } : repoRoot,
      );
      const sessions = await reloadSessions(repoRoot);
      set({
        ...applySessions(sessions, session.id),
        loading: false,
        repoRoot,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  addComment: async (input) => {
    try {
      const session = await window.anchor.annotations.addComment(input);
      const sessions = await reloadSessions(input.repoRoot);
      set({
        ...applySessions(sessions, session.id),
        repoRoot: input.repoRoot,
        toast: "Comment saved",
        error: null,
      });
    } catch (err) {
      set({
        toast: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  setStatus: async (commentId, status) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    const session = await window.anchor.annotations.setStatus({
      repoRoot,
      commentId,
      status,
    });
    const sessions = get().sessions.map((s) =>
      s.id === session.id ? session : s,
    );
    set({
      ...applySessions(sessions, get().expandedSessionId),
    });
  },

  reply: async (commentId, body) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    const session = await window.anchor.annotations.reply({
      repoRoot,
      commentId,
      body,
    });
    const sessions = get().sessions.map((s) =>
      s.id === session.id ? session : s,
    );
    set({
      ...applySessions(sessions, get().expandedSessionId),
      toast: "Reply added",
    });
  },

  editComment: async (commentId, body, messageId) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    const session = await window.anchor.annotations.editComment({
      repoRoot,
      commentId,
      body,
      messageId,
    });
    const sessions = get().sessions.map((s) =>
      s.id === session.id ? session : s,
    );
    set({
      ...applySessions(sessions, get().expandedSessionId),
      toast: "Comment updated",
    });
  },

  deleteComment: async (commentId) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    const session = await window.anchor.annotations.deleteComment({
      repoRoot,
      commentId,
    });
    const sessions = get().sessions.map((s) =>
      s.id === session.id ? session : s,
    );
    set({
      ...applySessions(sessions, get().expandedSessionId),
      toast: "Comment deleted",
    });
  },

  endSession: async () => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    try {
      const result = await window.anchor.annotations.endSession({
        repoRoot,
        export: true,
      });
      const sessions = await reloadSessions(repoRoot);
      set({
        ...applySessions(sessions, result.session?.id),
        toast: result.exportPath
          ? `Session ended · exported ${result.exportPath}`
          : "Session ended",
      });
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
    }
  },

  newSession: async (title) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    try {
      const session = await window.anchor.annotations.newSession(
        title ? { repoRoot, title } : repoRoot,
      );
      const sessions = await reloadSessions(repoRoot);
      set({
        ...applySessions(sessions, session.id),
        toast: "New session created",
      });
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
    }
  },

  startFreshSession: async (repoRoot, title) => {
    set({ repoRoot, error: null });
    try {
      const { sessions: existing } = await window.anchor.annotations.load(
        repoRoot,
      );
      if (existing.some((s) => s.status === "active")) {
        await window.anchor.annotations.endSession({
          repoRoot,
          export: true,
        });
      }
      const session = await window.anchor.annotations.newSession(
        title ? { repoRoot, title } : repoRoot,
      );
      const sessions = await reloadSessions(repoRoot);
      set({
        ...applySessions(sessions, session.id),
        repoRoot,
        toast: "New session started",
      });
    } catch (err) {
      set({
        toast: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  restoreSession: async (sessionId) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    try {
      const session = await window.anchor.annotations.restoreSession({
        repoRoot,
        sessionId,
      });
      const sessions = await reloadSessions(repoRoot);
      set({
        ...applySessions(sessions, session.id),
        toast: `Restored ${session.title}`,
      });
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
    }
  },

  exportSession: async (sessionId) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) {
      set({ toast: "No repository context" });
      return null;
    }
    try {
      const result = await window.anchor.annotations.exportSession({
        repoRoot,
        sessionId,
      });
      await navigator.clipboard.writeText(result.exportPath);
      set({ toast: `Export path copied: ${result.exportPath}` });
      return result.exportPath;
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  copyYamlPath: async (sessionId) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) {
      set({ toast: "No repository context" });
      return null;
    }
    try {
      const abs = await window.anchor.annotations.copyYamlPath(
        sessionId ? { repoRoot, sessionId } : repoRoot,
      );
      set({ toast: "YAML path copied" });
      return abs;
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },


  decorationsFor: (absolutePath, content) => {
    const { sessions, expandedSessionId, activeSession, repoRoot } = get();
    if (!repoRoot || sessions.length === 0) return [];

    // The selected sidebar session is the sole decoration source. Falling back
    // keeps a deterministic view before the sidebar has an explicit selection.
    const focusedSession = focusedSessionForDecorations(
      sessions,
      expandedSessionId,
      activeSession,
    );
    if (!focusedSession) return [];

    const specs: DecorationSpec[] = [];
    const seen = new Set<string>();
    for (const c of focusedSession.comments) {
      if (seen.has(c.id)) continue;
      if (!relativeMatch(repoRoot, absolutePath, c.target.file_path)) continue;
      const resolved = resolveAnchor(content, c.target);
      const badge =
        resolved.status === "relocated"
          ? "relocated"
          : resolved.status === "unresolved"
            ? "unresolved"
            : c.status;
      seen.add(c.id);
      specs.push({
        commentId: c.id,
        startLine: resolved.startLine,
        endLine: resolved.endLine,
        startColumn: resolved.startColumn,
        endColumn: resolved.endColumn,
        hover: `${focusedSession.title}: ${badge}: ${lastMessagePreview(c)}`,
        status: c.status,
        anchorStatus: resolved.status,
        overlapCount: 1,
      });
    }
    return specs.map((spec) => ({
      ...spec,
      overlapCount: specs.filter(
        (candidate) =>
          candidate.anchorStatus !== "unresolved" &&
          rangesOverlap(spec, candidate),
      ).length,
    }));
  },
}));
