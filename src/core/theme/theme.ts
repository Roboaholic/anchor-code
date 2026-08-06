import type { UiTheme } from "@/shared/anchor-api";

export type { UiTheme };

export const UI_THEMES: UiTheme[] = ["light", "light-modern", "dark", "dark-modern"];

/** Shared monospace stack for CodeViewer + DiffViewer (must stay identical). */
export const EDITOR_FONT_FAMILY =
  "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, 'Courier New', monospace";

/** Default editor / terminal / markdown reading font size (px). */
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 20;

/** Whole-workbench zoom percentage. */
export const DEFAULT_UI_SCALE = 100;
export const MIN_UI_SCALE = 80;
export const MAX_UI_SCALE = 150;

export function normalizeUiScale(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_UI_SCALE;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Math.round(n / 5) * 5));
}

export function normalizeFontSize(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(n)));
}

export function fontSizeShortcutDelta(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): -1 | 0 | 1 {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return 0;
  if (event.key === "+" || event.key === "=" || event.key === "Add") return 1;
  if (event.key === "-" || event.key === "_" || event.key === "Subtract") return -1;
  return 0;
}

/** Monaco line height scaled from font size (13px → 20). */
export function editorLineHeight(fontSize: number): number {
  return Math.max(16, Math.round(normalizeFontSize(fontSize) * (20 / 13)));
}

/** Rendered Markdown body size — slightly larger than editor mono. */
export function markdownFontSize(fontSize: number): number {
  return normalizeFontSize(fontSize) + 1.5;
}

/** Terminal font size — slightly smaller than editor mono. */
export function terminalFontSize(fontSize: number): number {
  return Math.max(11, normalizeFontSize(fontSize) - 0.5);
}

export function normalizeTheme(value: unknown): UiTheme {
  if (
    value === "dark" ||
    value === "dark-modern" ||
    value === "light" ||
    value === "light-modern"
  ) {
    return value;
  }
  return "dark-modern";
}

export function isDarkTheme(theme: UiTheme): boolean {
  return theme === "dark" || theme === "dark-modern";
}

/** Apply theme to documentElement for CSS variables / color-scheme. */
export function applyDocumentTheme(theme: UiTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = isDarkTheme(theme) ? "dark" : "light";
}

/** Monaco theme ids registered in monacoSetup. */
export function monacoThemeId(theme: UiTheme): string {
  if (theme === "dark-modern") return "anchor-dark-modern";
  if (theme === "dark") return "anchor-dark";
  if (theme === "light-modern") return "anchor-light-modern";
  return "anchor-light";
}

const XTERM_LIGHT: Record<string, string> = {
  background: "#faf9f7",
  foreground: "#1c1b19",
  cursor: "#8a6a2f",
  cursorAccent: "#faf9f7",
  selectionBackground: "#e8d9b5",
  selectionForeground: "#1c1b19",
  black: "#1c1b19",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#5c5954",
  magenta: "#7c5a3a",
  cyan: "#4a6b5c",
  white: "#e5e3df",
  brightBlack: "#8a857c",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#78746c",
  brightMagenta: "#a67c52",
  brightCyan: "#5a8a72",
  brightWhite: "#1c1b19",
};

const XTERM_LIGHT_MODERN: Record<string, string> = {
  background: "#ffffff",
  foreground: "#3b3b3b",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  selectionForeground: "#3b3b3b",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

const XTERM_DARK: Record<string, string> = {
  background: "#101011",
  foreground: "#ececec",
  cursor: "#d2b48c",
  cursorAccent: "#101011",
  selectionBackground: "#3a3426",
  selectionForeground: "#ececec",
  black: "#171718",
  red: "#f0a0a0",
  green: "#6bc49a",
  yellow: "#e0c070",
  blue: "#a8a8ad",
  magenta: "#c4a882",
  cyan: "#8fd4b0",
  white: "#e5e5e5",
  brightBlack: "#78787e",
  brightRed: "#f0b8b8",
  brightGreen: "#8fd4b0",
  brightYellow: "#ecd48a",
  brightBlue: "#c4c4c8",
  brightMagenta: "#d2b48c",
  brightCyan: "#a8e0c4",
  brightWhite: "#f5f5f5",
};

const XTERM_DARK_MODERN: Record<string, string> = {
  background: "#1f1f1f",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#1f1f1f",
  selectionBackground: "#264f78",
  selectionForeground: "#cccccc",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function xtermFallback(theme: UiTheme): Record<string, string> {
  if (theme === "dark-modern") return XTERM_DARK_MODERN;
  if (theme === "dark") return XTERM_DARK;
  if (theme === "light-modern") return XTERM_LIGHT_MODERN;
  return XTERM_LIGHT;
}

/** xterm.js ITheme derived from current CSS variables (or static fallbacks). */
export function xtermThemeFromCss(theme: UiTheme): Record<string, string> {
  const fallback = xtermFallback(theme);
  if (typeof document === "undefined") return { ...fallback };
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fb: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fb;
  };
  return {
    ...fallback,
    background: read("--terminal-bg", fallback.background),
    foreground: read("--terminal-fg", fallback.foreground),
    cursor: read("--terminal-cursor", fallback.cursor),
    selectionBackground: read(
      "--terminal-selection",
      fallback.selectionBackground,
    ),
    selectionForeground: read("--terminal-fg", fallback.selectionForeground),
  };
}

export function resolveInitialTheme(): UiTheme {
  try {
    const stored = localStorage.getItem("anchor.theme");
    return normalizeTheme(stored);
  } catch {
    // ignore
  }
  return "dark-modern";
}

export function cacheThemeLocally(theme: UiTheme): void {
  try {
    localStorage.setItem("anchor.theme", theme);
  } catch {
    // ignore
  }
}

/** Accent for Monaco decorations (matches CSS --accent). */
export function accentHex(theme: UiTheme): string {
  if (theme === "dark-modern") return "#3794ff";
  if (theme === "light-modern") return "#005fb8";
  if (theme === "dark") return "#d2b48c";
  return "#8a6a2f";
}
