import { describe, expect, it } from "vitest";
import {
  accentHex,
  editorLineHeight,
  fontSizeShortcutDelta,
  isDarkTheme,
  monacoThemeId,
  normalizeFontSize,
  normalizeUiScale,
  normalizeTheme,
  xtermThemeFromCss,
} from "./theme";

describe("normalizeTheme", () => {
  it("accepts light, light-modern, dark, and dark-modern", () => {
    expect(normalizeTheme("light")).toBe("light");
    expect(normalizeTheme("light-modern")).toBe("light-modern");
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("dark-modern")).toBe("dark-modern");
  });

  it("defaults unknown values to dark-modern", () => {
    expect(normalizeTheme(undefined)).toBe("dark-modern");
    expect(normalizeTheme("system")).toBe("dark-modern");
    expect(normalizeTheme(1)).toBe("dark-modern");
  });
});

describe("normalizeFontSize", () => {
  it("clamps and rounds font sizes", () => {
    expect(normalizeFontSize(13)).toBe(13);
    expect(normalizeFontSize("15")).toBe(15);
    expect(normalizeFontSize(10)).toBe(11);
    expect(normalizeFontSize(40)).toBe(20);
    expect(normalizeFontSize(undefined)).toBe(13);
  });

  it("scales monaco line height with font size", () => {
    expect(editorLineHeight(13)).toBe(20);
    expect(editorLineHeight(16)).toBe(25);
  });
});

describe("normalizeUiScale", () => {
  it("clamps and rounds UI scale to five-percent steps", () => {
    expect(normalizeUiScale(100)).toBe(100);
    expect(normalizeUiScale("112")).toBe(110);
    expect(normalizeUiScale(70)).toBe(80);
    expect(normalizeUiScale(180)).toBe(150);
    expect(normalizeUiScale(undefined)).toBe(100);
  });
});

describe("fontSizeShortcutDelta", () => {
  it("maps Ctrl/Cmd plus and minus without browser zoom", () => {
    expect(fontSizeShortcutDelta({ key: "+", ctrlKey: true, metaKey: false, altKey: false })).toBe(1);
    expect(fontSizeShortcutDelta({ key: "=", ctrlKey: false, metaKey: true, altKey: false })).toBe(1);
    expect(fontSizeShortcutDelta({ key: "-", ctrlKey: true, metaKey: false, altKey: false })).toBe(-1);
    expect(fontSizeShortcutDelta({ key: "_", ctrlKey: true, metaKey: false, altKey: false })).toBe(-1);
  });
    expect(fontSizeShortcutDelta({ key: "Add", ctrlKey: true, metaKey: false, altKey: false })).toBe(1);
    expect(fontSizeShortcutDelta({ key: "Subtract", ctrlKey: true, metaKey: false, altKey: false })).toBe(-1);

  it("ignores unmodified and Alt-modified keys", () => {
    expect(fontSizeShortcutDelta({ key: "+", ctrlKey: false, metaKey: false, altKey: false })).toBe(0);
    expect(fontSizeShortcutDelta({ key: "-", ctrlKey: true, metaKey: false, altKey: true })).toBe(0);
  });
});

describe("monacoThemeId", () => {
  it("maps to Anchor custom themes", () => {
    expect(monacoThemeId("light")).toBe("anchor-light");
    expect(monacoThemeId("light-modern")).toBe("anchor-light-modern");
    expect(monacoThemeId("dark")).toBe("anchor-dark");
    expect(monacoThemeId("dark-modern")).toBe("anchor-dark-modern");
  });
});

describe("isDarkTheme", () => {
  it("treats dark variants as dark", () => {
    expect(isDarkTheme("light")).toBe(false);
    expect(isDarkTheme("dark")).toBe(true);
    expect(isDarkTheme("dark-modern")).toBe(true);
  });
});

describe("accentHex", () => {
  it("uses sand for dark and blue for modern themes", () => {
    expect(accentHex("dark")).toBe("#d2b48c");
    expect(accentHex("dark-modern")).toBe("#3794ff");
    expect(accentHex("light-modern")).toBe("#005fb8");
    expect(accentHex("light")).toBe("#8a6a2f");
  });
});

describe("xtermThemeFromCss", () => {
  it("returns dark palette without document", () => {
    const t = xtermThemeFromCss("dark");
    expect(t.background).toBeTruthy();
    expect(t.foreground).toBeTruthy();
  });

  it("returns dark-modern palette without document", () => {
    const t = xtermThemeFromCss("dark-modern");
    expect(t.background).toBe("#1f1f1f");
    expect(t.selectionBackground).toBe("#264f78");
  });

  it("returns light palette without document", () => {
    const t = xtermThemeFromCss("light");
    expect(t.background).toMatch(/#fafafa|#faf9f7/i);
  });

  it("returns light-modern palette without document", () => {
    const t = xtermThemeFromCss("light-modern");
    expect(t.background).toBe("#ffffff");
    expect(t.selectionBackground).toBe("#add6ff");
  });
});
