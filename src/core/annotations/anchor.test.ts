import { describe, expect, it } from "vitest";
import { resolveAnchor, type AnchorTarget } from "./anchor";

function target(partial: Partial<AnchorTarget> & Pick<AnchorTarget, "selected_text">): AnchorTarget {
  return {
    start_line: 2,
    end_line: 2,
    start_column: 1,
    end_column: 5,
    before_context: "",
    after_context: "",
    ...partial,
  };
}

const SAMPLE = [
  "function buildPayload(input) {",
  "  const result = legacyTransform(input)",
  "  return normalize(result)",
  "}",
].join("\n");

describe("resolveAnchor", () => {
  it("resolves when selected_text still on original lines", () => {
    const r = resolveAnchor(
      SAMPLE,
      target({
        start_line: 2,
        end_line: 2,
        selected_text: "legacyTransform",
        start_column: 18,
        end_column: 33,
      }),
    );
    expect(r.status).toBe("resolved");
    expect(r.startLine).toBe(2);
    expect(r.endLine).toBe(2);
  });

  it("relocates selected_text after line drift", () => {
    const moved = [
      "// header",
      "// more",
      "function buildPayload(input) {",
      "  const result = legacyTransform(input)",
      "  return normalize(result)",
      "}",
    ].join("\n");
    const r = resolveAnchor(
      moved,
      target({
        start_line: 2,
        end_line: 2,
        selected_text: "legacyTransform",
      }),
    );
    expect(r.status).toBe("resolved");
    expect(r.startLine).toBe(4);
  });

  it("uses before/after context sandwich when text missing", () => {
    const content = [
      "alpha",
      "function buildPayload(input) {",
      "  // changed body",
      "  return normalize(result)",
      "}",
    ].join("\n");
    const r = resolveAnchor(
      content,
      target({
        start_line: 99,
        end_line: 99,
        selected_text: "this-text-is-gone",
        before_context: "function buildPayload(input) {",
        after_context: "return normalize(result)",
      }),
    );
    expect(r.status).toBe("resolved");
    expect(r.startLine).toBeGreaterThan(1);
  });

  it("marks unresolved when nothing matches", () => {
    const r = resolveAnchor(
      "hello\nworld\n",
      target({
        start_line: 5,
        end_line: 5,
        selected_text: "nope-not-here",
        before_context: "missing-before",
        after_context: "missing-after",
      }),
    );
    expect(r.status).toBe("unresolved");
    expect(r.startLine).toBe(5);
  });
});
