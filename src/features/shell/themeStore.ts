import { create } from "zustand";
import {
  applyDocumentTheme,
  cacheThemeLocally,
  normalizeTheme,
  resolveInitialTheme,
  type UiTheme,
} from "@/core/theme/theme";
import type { SessionTabLayout } from "@/shared/anchor-api";

function normalizeLayout(value: unknown): SessionTabLayout {
  return value === "top" ? "top" : "side";
}

function readCachedLayout(): SessionTabLayout {
  try {
    return normalizeLayout(localStorage.getItem("anchor.sessionTabLayout"));
  } catch {
    return "side";
  }
}

function cacheLayoutLocally(layout: SessionTabLayout): void {
  try {
    localStorage.setItem("anchor.sessionTabLayout", layout);
  } catch {
    // ignore
  }
}

export interface ThemeState {
  theme: UiTheme;
  /** Terminal / Agent session tab strip: side (default) or top. */
  sessionTabLayout: SessionTabLayout;
  ready: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Apply theme locally (DOM + store). Does not persist. */
  applyTheme: (theme: UiTheme) => void;
  /** Load from main process settings (falls back to local cache). */
  hydrate: () => Promise<void>;
  /** Persist theme via settings IPC and apply. */
  setTheme: (theme: UiTheme) => Promise<void>;
  /** Persist session tab layout and apply. */
  setSessionTabLayout: (layout: SessionTabLayout) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveInitialTheme(),
  sessionTabLayout: readCachedLayout(),
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
      if (
        fromMain === "light" ||
        fromMain === "light-modern" ||
        fromMain === "dark" ||
        fromMain === "dark-modern"
      ) {
        get().applyTheme(fromMain);
      }
    } catch {
      // keep local
    }
    try {
      const layout = await window.anchor?.settings?.getSessionTabLayout?.();
      if (layout === "side" || layout === "top") {
        cacheLayoutLocally(layout);
        set({ sessionTabLayout: layout });
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
      if (
        saved === "light" ||
        saved === "light-modern" ||
        saved === "dark" ||
        saved === "dark-modern"
      ) {
        get().applyTheme(saved);
      }
    } catch {
      // local already applied
    }
  },
  setSessionTabLayout: async (layout) => {
    const next = normalizeLayout(layout);
    cacheLayoutLocally(next);
    set({ sessionTabLayout: next });
    try {
      const saved = await window.anchor?.settings?.setSessionTabLayout?.(next);
      if (saved === "side" || saved === "top") {
        cacheLayoutLocally(saved);
        set({ sessionTabLayout: saved });
      }
    } catch {
      // local already applied
    }
  },
}));
