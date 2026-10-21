import type { BrowserWindow } from "electron";
import type { UiTheme } from "./settings.js";

/** Height of the fused menubar row (matches CSS --menubar-h). */
export const MENUBAR_OVERLAY_HEIGHT = 32;

/**
 * Panel / shell colors — keep in sync with `src/styles/global.css` `--bg-panel`
 * and `--bg` / `--text` for each theme.
 */
export const THEME_CHROME = {
  light: {
    panel: "#faf9f7",
    shell: "#f4f3f1",
    text: "#1c1b19",
  },
  "light-modern": {
    panel: "#ffffff",
    shell: "#f3f3f3",
    text: "#3b3b3b",
  },
  dark: {
    panel: "#171718",
    shell: "#101011",
    text: "#ececec",
  },
  "dark-modern": {
    panel: "#1f1f1f",
    shell: "#181818",
    text: "#cccccc",
  },
} as const satisfies Record<
  UiTheme,
  { panel: string; shell: string; text: string }
>;

/**
 * Caption overlay must match --bg-panel exactly so the top row is one surface.
 */
export function titleBarOverlayFor(theme: UiTheme): Electron.TitleBarOverlay {
  const c = THEME_CHROME[theme] ?? THEME_CHROME["dark-modern"];
  return {
    color: c.panel,
    symbolColor: c.text,
    height: MENUBAR_OVERLAY_HEIGHT,
  };
}

export function shellBackground(theme: UiTheme): string {
  return (THEME_CHROME[theme] ?? THEME_CHROME["dark-modern"]).shell;
}

export function applyWindowChromeTheme(
  win: BrowserWindow | null,
  theme: UiTheme,
): void {
  if (!win || win.isDestroyed()) return;
  try {
    win.setBackgroundColor(shellBackground(theme));
  } catch {
    // ignore
  }
  if (process.platform === "win32" || process.platform === "linux") {
    try {
      win.setTitleBarOverlay(titleBarOverlayFor(theme));
    } catch {
      // Older Electron / platform without overlay
    }
  }
}
