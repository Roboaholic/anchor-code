import { create } from "zustand";
import type { AskContext } from "./askPrompt";

type AskState = {
  context: AskContext | null;
  /** Unsent question text per selection (see askDraftKey); cleared on send. */
  drafts: Record<string, string>;
  open: (context: AskContext) => void;
  close: () => void;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
};

/** Ephemeral: Ask popovers and drafts are never persisted. */
export const useAskStore = create<AskState>((set) => ({
  context: null,
  drafts: {},
  open: (context) => set({ context }),
  close: () => set({ context: null }),
  setDraft: (key, text) =>
    set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
  clearDraft: (key) =>
    set((s) => {
      const next = { ...s.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));

export function openAsk(context: AskContext): void {
  if (!context.snippet.trim()) return;
  useAskStore.getState().open(context);
}

type MonacoLike = {
  getDomNode(): HTMLElement | null;
  getScrolledVisiblePosition(pos: { lineNumber: number; column: number }):
    | { top: number; left: number; height: number }
    | null;
  getLayoutInfo?(): { contentLeft: number };
};

/** Viewport rect of a Monaco line (popover anchor). Falls back to `fallback`. */
export function monacoLineAnchor(
  editor: MonacoLike | null | undefined,
  lineNumber: number,
  fallback?: Element | null,
  startLineNumber: number = lineNumber,
): AskContext["anchor"] {
  const dom = editor?.getDomNode();
  const pos = editor?.getScrolledVisiblePosition({ lineNumber, column: 1 });
  if (dom && pos) {
    const r = dom.getBoundingClientRect();
    const left = r.left + (editor?.getLayoutInfo?.().contentLeft ?? pos.left);
    const start = editor?.getScrolledVisiblePosition({
      lineNumber: startLineNumber,
      column: 1,
    });
    // Start line scrolled out above: clamp to the editor's top edge.
    const startTop = r.top + Math.max(0, start?.top ?? pos.top);
    return {
      top: r.top + pos.top,
      bottom: r.top + pos.top + pos.height,
      left,
      startTop,
    };
  }
  return elementAnchor(fallback);
}

export function elementAnchor(el: Element | null | undefined): AskContext["anchor"] {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left };
}
