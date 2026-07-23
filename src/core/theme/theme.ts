import type { UiTheme } from "@/shared/anchor-api";

export type { UiTheme };

export function normalizeTheme(value: unknown): UiTheme {
  return value === "dark" ? "dark" : "light";
}

/** Apply theme to documentElement for CSS variables / color-scheme. */
export function applyDocumentTheme(theme: UiTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * Monaco theme ids registered in monacoSetup (neutral zinc + warm sand).
 * Falls back to built-ins only if custom registration failed.
 */
export function monacoThemeId(theme: UiTheme): string {
  return theme === "dark" ? "anchor-dark" : "anchor-light";
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

/** xterm.js ITheme derived from current CSS variables (or static fallbacks). */
export function xtermThemeFromCss(theme: UiTheme): Record<string, string> {
  const fallback = theme === "dark" ? XTERM_DARK : XTERM_LIGHT;
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
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // ignore
  }
  return "light";
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
  return theme === "dark" ? "#d2b48c" : "#8a6a2f";
}
