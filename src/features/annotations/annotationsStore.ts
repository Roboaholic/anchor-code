import { create } from "zustand";
import { resolveAnchor } from "@/core/annotations/anchor";
import type {
  CommentRecord,
  SessionRecord,
  SessionSummary,
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
}

export interface AnnotationsState {
  repoRoot: string | null;
  activeSession: SessionRecord | null;
  sessions: SessionSummary[];
  error: string | null;
  toast: string | null;
  loading: boolean;

  loadForRepo: (repoRoot: string) => Promise<void>;
  ensureActive: (repoRoot: string, title?: string) => Promise<void>;
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
  return last?.body?.split("\n")[0] ?? "";
}

function relativeMatch(
  repoRoot: string,
  absolutePath: string,
  filePathRel: string,
): boolean {
  const normAbs = absolutePath.replace(/\\/g, "/");
  const normRoot = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = filePathRel.replace(/\\/g, "/");
  return (
    normAbs === `${normRoot}/${rel}` ||
    normAbs.endsWith(`/${rel}`) ||
    normAbs === rel
  );
}

async function refreshSummaries(
  repoRoot: string,
): Promise<SessionSummary[]> {
  const { sessions } = await window.anchor.annotations.list(repoRoot);
  return sessions;
}

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  repoRoot: null,
  activeSession: null,
  sessions: [],
  error: null,
  toast: null,
  loading: false,

  reset: () =>
    set({
      repoRoot: null,
      activeSession: null,
      sessions: [],
      error: null,
      toast: null,
      loading: false,
    }),

  clearToast: () => set({ toast: null }),

  loadForRepo: async (repoRoot) => {
    set({ loading: true, error: null, repoRoot });
    try {
      const { sessions, error } = await window.anchor.annotations.load(repoRoot);
      if (error) {
        set({ loading: false, error, activeSession: null, sessions: [] });
        return;
      }
      const active = sessions.find((s) => s.status === "active") ?? null;
      const summaries = sessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        created_at: s.created_at,
        ended_at: s.ended_at,
        commentCount: s.comments.length,
        filePath: s.filePath,
      }));
      set({
        activeSession: active,
        sessions: summaries,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  ensureActive: async (repoRoot, title) => {
    set({ loading: true, error: null, repoRoot });
    try {
      const session = await window.anchor.annotations.ensureActive(
        title ? { repoRoot, title } : repoRoot,
      );
      const sessions = await refreshSummaries(repoRoot);
      set({ activeSession: session, sessions, loading: false });
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
      const sessions = await refreshSummaries(input.repoRoot);
      set({
        activeSession: session,
        sessions,
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
    set({ activeSession: session });
  },

  reply: async (commentId, body) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    const session = await window.anchor.annotations.reply({
      repoRoot,
      commentId,
      body,
    });
    set({ activeSession: session, toast: "Reply added" });
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
    set({ activeSession: session, toast: "Comment updated" });
  },

  deleteComment: async (commentId) => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    const session = await window.anchor.annotations.deleteComment({
      repoRoot,
      commentId,
    });
    const sessions = await refreshSummaries(repoRoot);
    set({ activeSession: session, sessions, toast: "Comment deleted" });
  },

  endSession: async () => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    try {
      const result = await window.anchor.annotations.endSession({
        repoRoot,
        export: true,
      });
      const sessions = await refreshSummaries(repoRoot);
      set({
        activeSession: null,
        sessions,
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
      const sessions = await refreshSummaries(repoRoot);
      set({
        activeSession: session,
        sessions,
        toast: "New session created",
      });
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
    }
  },

  startFreshSession: async (repoRoot, title) => {
    set({ repoRoot, error: null });
    try {
      // End active with export if present (no-op when none).
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
      const sessions = await refreshSummaries(repoRoot);
      set({
        activeSession: session,
        sessions,
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
      const sessions = await refreshSummaries(repoRoot);
      set({
        activeSession: session,
        sessions,
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
      await window.anchor.clipboard.writeText(result.exportPath);
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
    const { activeSession, repoRoot } = get();
    if (!activeSession || !repoRoot) return [];
    const specs: DecorationSpec[] = [];
    for (const c of activeSession.comments) {
      if (!relativeMatch(repoRoot, absolutePath, c.target.file_path)) continue;
      const resolved = resolveAnchor(content, c.target);
      const badge =
        resolved.status === "relocated"
          ? "relocated"
          : resolved.status === "unresolved"
            ? "unresolved"
            : c.status;
      specs.push({
        commentId: c.id,
        startLine: resolved.startLine,
        endLine: resolved.endLine,
        startColumn: resolved.startColumn,
        endColumn: resolved.endColumn,
        hover: `${badge}: ${lastMessagePreview(c)}`,
        status: c.status,
        anchorStatus: resolved.status,
      });
    }
    return specs;
  },
}));
