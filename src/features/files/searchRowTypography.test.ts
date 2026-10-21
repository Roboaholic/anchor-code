import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "../../styles/global.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Last `line-height` set by a top-level rule whose selector list contains `selector` verbatim. */
function lastLineHeight(selector: string): string | null {
  let found: string | null = null;
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const lh = /(?:^|;)\s*line-height:\s*([^;]+)/.exec(m[2]!);
    if (lh) found = lh[1]!.trim();
  }
  return found;
}

/** Unitless multiplier for a line-height value at a given font size. */
function ratio(value: string, fontPx: number): number {
  if (value.endsWith("px")) return parseFloat(value) / fontPx;
  return parseFloat(value);
}

// UI fonts need ~1.21em (Inter) to ~1.33em (Segoe UI) for ascent + descent;
// the name / path spans clip with overflow:hidden, so a smaller line box cuts
// descenders ("g" in log.md).
const MIN_RATIO = 1.34;

describe("search result row typography", () => {
  it("gives the file head a line box tall enough for descenders", () => {
    const lh = lastLineHeight(".files-search-group__head");
    expect(lh).not.toBeNull();
    expect(ratio(lh!, 12)).toBeGreaterThanOrEqual(MIN_RATIO);
    // The clipped spans must not shrink it again.
    for (const span of [".files-search-group__name", ".files-search-group__file", ".files-search-group__dir"]) {
      expect(lastLineHeight(span)).toBeNull();
    }
  });

  it("keeps hit rows on an inherited or explicit tall line box", () => {
    const lh = lastLineHeight(".files-search-hit");
    if (lh !== null) expect(ratio(lh, 11.5)).toBeGreaterThanOrEqual(MIN_RATIO);
    for (const span of [".files-search-hit__text", ".files-search-hit__after", ".files-search-hit__before"]) {
      const v = lastLineHeight(span);
      if (v !== null) expect(ratio(v, 11.5)).toBeGreaterThanOrEqual(MIN_RATIO);
    }
  });
});
