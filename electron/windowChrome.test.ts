import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shellBackground,
  THEME_CHROME,
  titleBarOverlayFor,
} from "./windowChrome.js";
import type { UiTheme } from "./settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBAL_CSS = join(HERE, "../src/styles/global.css");

function themeBlock(css: string, theme: UiTheme): string {
  if (theme === "light") {
    const start = css.indexOf(':root,\n:root[data-theme="light"]');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = css.indexOf("\n}", start);
    return css.slice(start, end + 2);
  }
  const start = css.indexOf(`:root[data-theme="${theme}"]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end + 2);
}

function cssVar(block: string, name: string): string | null {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

describe("windowChrome theme colors", () => {
  const css = readFileSync(GLOBAL_CSS, "utf8").replace(/\r\n/g, "\n");
  const themes: UiTheme[] = ["light", "light-modern", "dark", "dark-modern"];

  for (const theme of themes) {
    it(`matches CSS tokens for ${theme}`, () => {
      const block = themeBlock(css, theme);
      const panel = cssVar(block, "bg-panel");
      const bg = cssVar(block, "bg");
      const text = cssVar(block, "text");
      expect(panel).toBe(THEME_CHROME[theme].panel);
      expect(bg).toBe(THEME_CHROME[theme].shell);
      expect(text).toBe(THEME_CHROME[theme].text);
      expect(titleBarOverlayFor(theme).color).toBe(panel);
      expect(titleBarOverlayFor(theme).symbolColor).toBe(text);
      expect(shellBackground(theme)).toBe(bg);
    });
  }
});
