// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  collectTextChunks,
  findTextSpans,
  rangeForSpan,
  rangesForSpans,
  shouldClaimMarkdownFindShortcut,
  stepMatchIndex,
} from "./mdPreviewFind";

describe("findTextSpans", () => {
  it("returns empty for empty query", () => {
    expect(findTextSpans("hello hello", "")).toEqual([]);
  });

  it("finds non-overlapping case-insensitive matches by default", () => {
    expect(findTextSpans("Foo foo FOO", "foo")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it("honors case sensitivity", () => {
    expect(findTextSpans("Foo foo FOO", "foo", true)).toEqual([
      { start: 4, end: 7 },
    ]);
  });

  it("does not overlap successive matches", () => {
    expect(findTextSpans("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("stepMatchIndex", () => {
  it("returns -1 when there are no matches", () => {
    expect(stepMatchIndex(0, 0, 1)).toBe(-1);
    expect(stepMatchIndex(-1, 0, -1)).toBe(-1);
  });

  it("starts at first/last when current is unset", () => {
    expect(stepMatchIndex(-1, 3, 1)).toBe(0);
    expect(stepMatchIndex(-1, 3, -1)).toBe(2);
  });

  it("wraps around", () => {
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(1, 3, 1)).toBe(2);
  });
});

describe("collectTextChunks / rangeForSpan", () => {
  it("maps absolute spans onto DOM Ranges across text nodes", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Hello <strong>world</strong> again</p>";
    document.body.appendChild(root);
    const { text, chunks } = collectTextChunks(root);
    expect(text).toBe("Hello world again");
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const spans = findTextSpans(text, "o");
    // "o" in Hello, world
    expect(spans.length).toBeGreaterThanOrEqual(2);
    const ranges = rangesForSpans(chunks, spans);
    expect(ranges.length).toBe(spans.length);
    expect(ranges[0]!.toString().toLowerCase()).toBe("o");

    const world = findTextSpans(text, "world")[0]!;
    const range = rangeForSpan(chunks, world);
    expect(range?.toString()).toBe("world");
    root.remove();
  });
});

describe("shouldClaimMarkdownFindShortcut", () => {
  function surface() {
    const el = document.createElement("div");
    el.className = "md-viewer__rendered-surface";
    return el;
  }

  it("claims when there is no document pane (standalone / tests)", () => {
    const root = surface();
    expect(
      shouldClaimMarkdownFindShortcut({
        pane: null,
        surface: root,
        activeElement: document.body,
        findOpen: false,
        selectionInsideSurface: false,
      }),
    ).toBe(true);
  });

  it("does not claim for a hidden or inactive document pane", () => {
    const root = surface();
    const pane = document.createElement("div");
    pane.className = "document-area__pane";
    pane.hidden = true;
    expect(
      shouldClaimMarkdownFindShortcut({
        pane,
        surface: root,
        activeElement: document.body,
        findOpen: true,
        selectionInsideSurface: false,
      }),
    ).toBe(false);

    pane.hidden = false;
    pane.setAttribute("aria-hidden", "true");
    expect(
      shouldClaimMarkdownFindShortcut({
        pane,
        surface: root,
        activeElement: document.body,
        findOpen: true,
        selectionInsideSurface: false,
      }),
    ).toBe(false);

    pane.removeAttribute("aria-hidden");
    // mounted but not the active tab
    expect(
      shouldClaimMarkdownFindShortcut({
        pane,
        surface: root,
        activeElement: document.body,
        findOpen: true,
        selectionInsideSurface: true,
      }),
    ).toBe(false);
  });

  it("claims for an active pane with body focus or selection inside", () => {
    const root = surface();
    const pane = document.createElement("div");
    pane.className = "document-area__pane is-active";
    expect(
      shouldClaimMarkdownFindShortcut({
        pane,
        surface: root,
        activeElement: document.body,
        findOpen: false,
        selectionInsideSurface: false,
      }),
    ).toBe(true);
    expect(
      shouldClaimMarkdownFindShortcut({
        pane,
        surface: root,
        activeElement: document.createElement("textarea"),
        findOpen: false,
        selectionInsideSurface: true,
      }),
    ).toBe(true);
  });

  it("does not claim when focus is outside an active pane and find is closed", () => {
    const root = surface();
    const pane = document.createElement("div");
    pane.className = "document-area__pane is-active";
    const terminalInput = document.createElement("textarea");
    terminalInput.className = "xterm-helper-textarea";
    expect(
      shouldClaimMarkdownFindShortcut({
        pane,
        surface: root,
        activeElement: terminalInput,
        findOpen: false,
        selectionInsideSurface: false,
      }),
    ).toBe(false);
  });
});
