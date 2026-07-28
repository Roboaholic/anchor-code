import { create } from "zustand";
import {
  applyDocumentTheme,
  cacheThemeLocally,
  DEFAULT_FONT_SIZE,
  normalizeFontSize,
  normalizeTheme,
  resolveInitialTheme,
  type UiTheme,
} from "@/core/theme/theme";
import type { SessionTabLayout } from "@/shared/anchor-api";

const FONT_SIZE_STORAGE_KEY = "anchor.fontSize";

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

function readCachedFontSize(): number {
  try {
    return normalizeFontSize(localStorage.getItem(FONT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

function cacheFontSizeLocally(fontSize: number): void {
  try {
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(normalizeFontSize(fontSize)));
  } catch {
    // ignore
  }
}

function applyDocumentFontSize(fontSize: number): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--editor-font-size",
    `${normalizeFontSize(fontSize)}px`,
  );
}

export type SettingsFocusSection = "appearance" | "agent-skill" | "updates";

export interface ThemeState {
  theme: UiTheme;
  /** Terminal / Agent session tab strip: side (default) or top. */
  sessionTabLayout: SessionTabLayout;
  /** Editor / Markdown / terminal reading font size in px. */
  fontSize: number;
  ready: boolean;
  settingsOpen: boolean;
  /** When set, SettingsPanel selects this section on open. */
  settingsFocusSection: SettingsFocusSection | null;
  setSettingsOpen: (open: boolean) => void;
  openSettings: (section?: SettingsFocusSection) => void;
  /** Apply theme locally (DOM + store). Does not persist. */
  applyTheme: (theme: UiTheme) => void;
  /** Apply font size locally (DOM + store). Does not persist. */
  applyFontSize: (fontSize: number) => void;
  /** Load from main process settings (falls back to local cache). */
  hydrate: () => Promise<void>;
  /** Persist theme via settings IPC and apply. */
  setTheme: (theme: UiTheme) => Promise<void>;
  /** Persist session tab layout and apply. */
  setSessionTabLayout: (layout: SessionTabLayout) => Promise<void>;
  /** Persist font size via settings IPC and apply. */
  setFontSize: (fontSize: number) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveInitialTheme(),
  sessionTabLayout: readCachedLayout(),
  fontSize: readCachedFontSize(),
  ready: false,
  settingsOpen: false,
  settingsFocusSection: null,
  setSettingsOpen: (open) =>
    set(
      open
        ? { settingsOpen: true }
        : { settingsOpen: false, settingsFocusSection: null },
    ),
  openSettings: (section) =>
    set({
      settingsOpen: true,
      settingsFocusSection: section ?? null,
    }),
  applyTheme: (theme) => {
    const next = normalizeTheme(theme);
    applyDocumentTheme(next);
    cacheThemeLocally(next);
    set({ theme: next });
  },
  applyFontSize: (fontSize) => {
    const next = normalizeFontSize(fontSize);
    applyDocumentFontSize(next);
    cacheFontSizeLocally(next);
    set({ fontSize: next });
  },
  hydrate: async () => {
    // Paint cached theme/font immediately to avoid flash.
    applyDocumentTheme(get().theme);
    applyDocumentFontSize(get().fontSize);
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
    }
    try {
      const size = await window.anchor?.settings?.getFontSize?.();
      if (typeof size === "number") {
        get().applyFontSize(size);
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
  setFontSize: async (fontSize) => {
    const next = normalizeFontSize(fontSize);
    get().applyFontSize(next);
    try {
      const saved = await window.anchor?.settings?.setFontSize?.(next);
      if (typeof saved === "number") {
        get().applyFontSize(saved);
      }
    } catch {
      // local already applied
    }
  },
}));
