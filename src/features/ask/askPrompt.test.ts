import { describe, expect, it } from "vitest";
import {
  askLineLabel,
  askPasteChunks,
  buildAskPrompt,
  isAskSessionSelectable,
} from "./askPrompt";

const ctx = {
  path: "/repo/src/a.ts",
  startLine: 3,
  endLine: 5,
  snippet: "const a = 1;\nconst b = 2;",
};

describe("buildAskPrompt", () => {
  it("includes path, lines, snippet and question", () => {
    const p = buildAskPrompt({ context: ctx, question: "  why?  ", readOnly: false });
    expect(p).toContain("File: /repo/src/a.ts");
    expect(p).toContain("Lines: L3-5");
    expect(p).toContain("const a = 1;\nconst b = 2;");
    expect(p.trimEnd().endsWith("why?")).toBe(true);
    expect(p).not.toContain("Read-only");
    expect(p).not.toContain("Diff:");
  });

  it("adds read-only instruction and diff metadata", () => {
    const p = buildAskPrompt({
      context: {
        ...ctx,
        diff: { repoRoot: "/repo", branch: "main", base: "abc123", head: "worktree" },
      },
      question: "what changed?",
      readOnly: true,
    });
    expect(p).toContain("Read-only: answer the question only");
    expect(p).toContain("Diff: repo /repo (branch main), base abc123, head worktree");
  });

  it("clips very long snippets", () => {
    const p = buildAskPrompt({
      context: { ...ctx, snippet: "x".repeat(9_000) },
      question: "q",
      readOnly: true,
    });
    expect(p).toContain("snippet clipped");
    expect(p.length).toBeLessThan(9_000);
  });

  it("formats single-line labels", () => {
    expect(askLineLabel({ startLine: 7, endLine: 7 })).toBe("L7");
  });
});

describe("isAskSessionSelectable (idle gating)", () => {
  const agent = { kind: "agent", status: "running" as const };
  it("allows idle and completed-unread", () => {
    expect(isAskSessionSelectable(agent, "idle")).toBe(true);
    expect(isAskSessionSelectable(agent, undefined)).toBe(true);
    expect(isAskSessionSelectable(agent, "completed-unread")).toBe(true);
  });
  it("blocks working, exited and shell tabs", () => {
    expect(isAskSessionSelectable(agent, "working")).toBe(false);
    expect(isAskSessionSelectable({ ...agent, status: "exited" }, "idle")).toBe(false);
    expect(isAskSessionSelectable({ kind: "shell", status: "running" }, "idle")).toBe(false);
  });
});

describe("askPasteChunks", () => {
  it("wraps in bracketed paste and submits separately", () => {
    expect(askPasteChunks("hi\nthere")).toEqual(["\x1b[200~hi\nthere\x1b[201~", "\r"]);
  });
  it("strips embedded paste markers", () => {
    const [body] = askPasteChunks("a\x1b[201~rm -rf\x1b[200~b");
    expect(body).toBe("\x1b[200~arm -rfb\x1b[201~");
  });
});
