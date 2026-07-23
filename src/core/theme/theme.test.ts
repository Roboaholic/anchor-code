import { describe, expect, it } from "vitest";
import {
  monacoThemeId,
  normalizeTheme,
  xtermThemeFromCss,
} from "./theme";

describe("normalizeTheme", () => {
  it("accepts light and dark", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("dark")).toBe("dark");
  });

  it("defaults unknown values to light", () => {
    expect(normalizeTheme(undefined)).toBe("light");
    expect(normalizeTheme("system")).toBe("light");
    expect(normalizeTheme(1)).toBe("light");
  });
});

describe("monacoThemeId", () => {
  it("maps to Anchor custom themes", () => {
    expect(monacoThemeId("light")).toBe("anchor-light");
    expect(monacoThemeId("dark")).toBe("anchor-dark");
  });
});

describe("xtermThemeFromCss", () => {
  it("returns dark palette without document", () => {
    const t = xtermThemeFromCss("dark");
    expect(t.background).toBeTruthy();
    expect(t.foreground).toBeTruthy();
    expect(t.cursor).toBeTruthy();
  });

  it("returns light palette without document", () => {
    const t = xtermThemeFromCss("light");
    expect(t.background).toMatch(/#fafafa|#/i);
  });
});
