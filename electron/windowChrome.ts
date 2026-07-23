import type { BrowserWindow } from "electron";
import type { UiTheme } from "./settings.js";

/** Height of the fused menubar row (matches CSS --menubar-h). */
export const MENUBAR_OVERLAY_HEIGHT = 32;

/**
 * Caption overlay must match --bg-panel exactly so the top row is one surface.
 */
export function titleBarOverlayFor(theme: UiTheme): Electron.TitleBarOverlay {
  if (theme === "dark-modern") {
    return {
      color: "#1f1f1f",
      symbolColor: "#cccccc",
      height: MENUBAR_OVERLAY_HEIGHT,
    };
  }
  if (theme === "dark") {
    return {
      color: "#171718",
      symbolColor: "#ececec",
      height: MENUBAR_OVERLAY_HEIGHT,
    };
  }
  if (theme === "light-modern") {
    return {
      color: "#ffffff",
      symbolColor: "#3b3b3b",
      height: MENUBAR_OVERLAY_HEIGHT,
    };
  }
  return {
    color: "#faf9f7",
    symbolColor: "#1c1b19",
    height: MENUBAR_OVERLAY_HEIGHT,
  };
}

export function shellBackground(theme: UiTheme): string {
  if (theme === "dark-modern") return "#181818";
  if (theme === "dark") return "#101011";
  if (theme === "light-modern") return "#f3f3f3";
  return "#f4f3f1";
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
