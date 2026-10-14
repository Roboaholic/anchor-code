import { create } from "zustand";
import type { CommentRecord } from "@/shared/anchor-api";

export type CommentDraft = { body: string; status: CommentRecord["status"] };

/** In-memory drafts for the new-comment popover, keyed per selection. */
type CommentDraftState = {
  drafts: Record<string, CommentDraft>;
  setDraft: (key: string, draft: CommentDraft) => void;
  clearDraft: (key: string) => void;
};

export const DEFAULT_COMMENT_DRAFT: CommentDraft = { body: "", status: "discussing" };

export function commentDraftKey(path: string, startLine: number, endLine: number): string {
  return `${path}#${startLine}-${endLine}`;
}

export const useCommentDraftStore = create<CommentDraftState>((set) => ({
  drafts: {},
  setDraft: (key, draft) =>
    set((s) => ({ drafts: { ...s.drafts, [key]: draft } })),
  clearDraft: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s;
      const next = { ...s.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));
