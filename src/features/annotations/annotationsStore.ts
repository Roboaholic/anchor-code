import { create } from "zustand";
import { resolveAnchor } from "@/core/annotations/anchor";
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
  anchorStatus: "resolved" | "unresolved";
}

export interface AnnotationsState {
  repoRoot: string | null;
  activeSession: SessionRecord | null;
  error: string | null;
  toast: string | null;
  loading: boolean;

  loadForRepo: (repoRoot: string) => Promise<void>;
  ensureActive: (repoRoot: string) => Promise<void>;
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
    body: string;
  }) => Promise<void>;
  setStatus: (
    commentId: string,
    status: CommentRecord["status"],
  ) => Promise<void>;
  reply: (commentId: string, body: string) => Promise<void>;
  endSession: () => Promise<void>;
  newSession: () => Promise<void>;
  copyYamlPath: () => Promise<string | null>;
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

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  repoRoot: null,
  activeSession: null,
  error: null,
  toast: null,
  loading: false,

  reset: () =>
    set({
      repoRoot: null,
      activeSession: null,
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
        set({ loading: false, error, activeSession: null });
        return;
      }
      const active =
        sessions.find((s) => s.status === "active") ?? null;
      set({ activeSession: active, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  ensureActive: async (repoRoot) => {
    set({ loading: true, error: null, repoRoot });
    try {
      const session = await window.anchor.annotations.ensureActive(repoRoot);
      set({ activeSession: session, loading: false });
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
      set({
        activeSession: session,
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
    set({ activeSession: session });
  },

  endSession: async () => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    await window.anchor.annotations.endSession(repoRoot);
    set({ activeSession: null, toast: "Session ended" });
  },

  newSession: async () => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) return;
    try {
      const session = await window.anchor.annotations.newSession(repoRoot);
      set({ activeSession: session, toast: "New session created" });
    } catch (err) {
      set({ toast: err instanceof Error ? err.message : String(err) });
    }
  },

  copyYamlPath: async () => {
    const repoRoot = get().repoRoot;
    if (!repoRoot) {
      set({ toast: "No repository context" });
      return null;
    }
    try {
      const abs = await window.anchor.annotations.copyYamlPath(repoRoot);
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
      specs.push({
        commentId: c.id,
        startLine: resolved.startLine,
        endLine: resolved.endLine,
        startColumn: resolved.startColumn,
        endColumn: resolved.endColumn,
        hover: `${c.status}: ${lastMessagePreview(c)}`,
        status: c.status,
        anchorStatus: resolved.status,
      });
    }
    return specs;
  },
}));
