import { create } from "zustand";
import {
  applyDocumentTheme,
  cacheThemeLocally,
  normalizeTheme,
  resolveInitialTheme,
  type UiTheme,
} from "@/core/theme/theme";

export interface ThemeState {
  theme: UiTheme;
  ready: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Apply theme locally (DOM + store). Does not persist. */
  applyTheme: (theme: UiTheme) => void;
  /** Load from main process settings (falls back to local cache). */
  hydrate: () => Promise<void>;
  /** Persist theme via settings IPC and apply. */
  setTheme: (theme: UiTheme) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveInitialTheme(),
  ready: false,
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  applyTheme: (theme) => {
    const next = normalizeTheme(theme);
    applyDocumentTheme(next);
    cacheThemeLocally(next);
    set({ theme: next });
  },
  hydrate: async () => {
    // Paint cached theme immediately to avoid flash.
    applyDocumentTheme(get().theme);
    try {
      const fromMain = await window.anchor?.settings?.getTheme?.();
      if (fromMain === "light" || fromMain === "dark") {
        get().applyTheme(fromMain);
      }
    } catch {
      // keep local
    } finally {
      set({ ready: true });
    }
  },
  setTheme: async (theme) => {
    const next = normalizeTheme(theme);
    get().applyTheme(next);
    try {
      const saved = await window.anchor?.settings?.setTheme?.(next);
      if (saved === "light" || saved === "dark") {
        get().applyTheme(saved);
      }
    } catch {
      // local already applied
    }
  },
}));
