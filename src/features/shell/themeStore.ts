import { create } from "zustand";
import {
  applyDocumentTheme,
  cacheThemeLocally,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_UI_SCALE,
  EDITOR_FONT_FAMILY,
  normalizeEditorFontFamily,
  normalizeFontSize,
  normalizeLineHeight,
  normalizeTheme,
  normalizeUiScale,
  resolveInitialTheme,
  type UiTheme,
} from "@/core/theme/theme";
import type { SessionTabLayout } from "@/shared/anchor-api";

const FONT_SIZE_STORAGE_KEY = "anchor.fontSize";
const UI_SCALE_STORAGE_KEY = "anchor.uiScale";
const FONT_FAMILY_STORAGE_KEY = "anchor.editorFontFamily";
const LINE_HEIGHT_STORAGE_KEY = "anchor.lineHeight";

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

function readCachedUiScale(): number {
  try {
    return normalizeUiScale(localStorage.getItem(UI_SCALE_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

function cacheUiScaleLocally(uiScale: number): void {
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(normalizeUiScale(uiScale)));
  } catch {
    // ignore
  }
}

function readCachedFontFamily(): string {
  try {
    return normalizeEditorFontFamily(
      localStorage.getItem(FONT_FAMILY_STORAGE_KEY),
    );
  } catch {
    return EDITOR_FONT_FAMILY;
  }
}

function cacheFontFamilyLocally(fontFamily: string): void {
  try {
    localStorage.setItem(
      FONT_FAMILY_STORAGE_KEY,
      normalizeEditorFontFamily(fontFamily),
    );
  } catch {
    // ignore
  }
}

function applyDocumentFontFamily(fontFamily: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--editor-font-family",
    normalizeEditorFontFamily(fontFamily),
  );
}

function readCachedLineHeight(): number {
  try {
    return normalizeLineHeight(localStorage.getItem(LINE_HEIGHT_STORAGE_KEY));
  } catch {
    return DEFAULT_LINE_HEIGHT;
  }
}

function cacheLineHeightLocally(lineHeight: number): void {
  try {
    localStorage.setItem(
      LINE_HEIGHT_STORAGE_KEY,
      String(normalizeLineHeight(lineHeight)),
    );
  } catch {
    // ignore
  }
}

export type SettingsFocusSection =
  | "appearance"
  | "theme"
  | "agent"
  | "agent-skill"
  | "updates"
  | "experimental";

export interface ThemeState {
  theme: UiTheme;
  /** Terminal / Agent session tab strip: side (default) or top. */
  sessionTabLayout: SessionTabLayout;
  /** Editor / Markdown / terminal reading font size in px. */
  fontSize: number;
  /** CSS font-family stack for editor / diff / terminal. */
  editorFontFamily: string;
  /** Monaco line-height multiplier. */
  lineHeight: number;
  /** Whole-workbench zoom percentage. */
  uiScale: number;
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
  applyEditorFontFamily: (fontFamily: string) => void;
  applyLineHeight: (lineHeight: number) => void;
  /** Apply UI scale to store/cache. Electron applies the zoom in preload. */
  applyUiScale: (uiScale: number) => void;
  /** Load from main process settings (falls back to local cache). */
  hydrate: () => Promise<void>;
  /** Persist theme via settings IPC and apply. */
  setTheme: (theme: UiTheme) => Promise<void>;
  /** Persist session tab layout and apply. */
  setSessionTabLayout: (layout: SessionTabLayout) => Promise<void>;
  /** Persist font size via settings IPC and apply. */
  setFontSize: (fontSize: number) => Promise<void>;
  setEditorFontFamily: (fontFamily: string) => Promise<void>;
  setLineHeight: (lineHeight: number) => Promise<void>;
  /** Persist whole-workbench zoom and apply. */
  setUiScale: (uiScale: number) => Promise<void>;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveInitialTheme(),
  sessionTabLayout: readCachedLayout(),
  fontSize: readCachedFontSize(),
  editorFontFamily: readCachedFontFamily(),
  lineHeight: readCachedLineHeight(),
  uiScale: readCachedUiScale(),
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
  applyEditorFontFamily: (fontFamily) => {
    const next = normalizeEditorFontFamily(fontFamily);
    applyDocumentFontFamily(next);
    cacheFontFamilyLocally(next);
    set({ editorFontFamily: next });
  },
  applyLineHeight: (lineHeight) => {
    const next = normalizeLineHeight(lineHeight);
    cacheLineHeightLocally(next);
    set({ lineHeight: next });
  },
  applyUiScale: (uiScale) => {
    const next = normalizeUiScale(uiScale);
    cacheUiScaleLocally(next);
    set({ uiScale: next });
  },
  hydrate: async () => {
    // Paint cached theme/font immediately to avoid flash.
    applyDocumentTheme(get().theme);
    applyDocumentFontSize(get().fontSize);
    applyDocumentFontFamily(get().editorFontFamily);
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
    }
    try {
      const family = await window.anchor?.settings?.getEditorFontFamily?.();
      if (typeof family === "string") {
        get().applyEditorFontFamily(family);
      }
    } catch {
      // keep local
    }
    try {
      const lh = await window.anchor?.settings?.getLineHeight?.();
      if (typeof lh === "number") {
        get().applyLineHeight(lh);
      }
    } catch {
      // keep local
    }
    try {
      const scale = await window.anchor?.settings?.getUiScale?.();
      if (typeof scale === "number") {
        get().applyUiScale(scale);
      }
    } catch {
      // Apply the cached value when the persisted setting is unavailable.
      void window.anchor?.settings?.setUiScale?.(get().uiScale);
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
  setEditorFontFamily: async (fontFamily) => {
    const next = normalizeEditorFontFamily(fontFamily);
    get().applyEditorFontFamily(next);
    try {
      const saved = await window.anchor?.settings?.setEditorFontFamily?.(next);
      if (typeof saved === "string") {
        get().applyEditorFontFamily(saved);
      }
    } catch {
      // local already applied
    }
  },
  setLineHeight: async (lineHeight) => {
    const next = normalizeLineHeight(lineHeight);
    get().applyLineHeight(next);
    try {
      const saved = await window.anchor?.settings?.setLineHeight?.(next);
      if (typeof saved === "number") {
        get().applyLineHeight(saved);
      }
    } catch {
      // local already applied
    }
  },
  setUiScale: async (uiScale) => {
    const next = normalizeUiScale(uiScale);
    get().applyUiScale(next);
    try {
      const saved = await window.anchor?.settings?.setUiScale?.(next);
      if (typeof saved === "number") {
        get().applyUiScale(saved);
      }
    } catch {
      // local already applied
    }
  },
}));
