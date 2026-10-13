import { create } from "zustand";
import type { AskContext } from "./askPrompt";

type AskState = {
  context: AskContext | null;
  open: (context: AskContext) => void;
  close: () => void;
};

/** Ephemeral: Ask dialogs are never persisted. */
export const useAskStore = create<AskState>((set) => ({
  context: null,
  open: (context) => set({ context }),
  close: () => set({ context: null }),
}));

export function openAsk(context: AskContext): void {
  if (!context.snippet.trim()) return;
  useAskStore.getState().open(context);
}
