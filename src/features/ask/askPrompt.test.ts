import { describe, expect, it } from "vitest";
import {
  askDraftKey,
  askLineLabel,
  askPopoverPosition,
  askSessionLabel,
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

describe("askSessionLabel", () => {
  const base = { title: "You are applying Anchor Code review fee…", status: "running" as const, agentId: "claude" };
  it("hides raw prompt titles behind an index", () => {
    expect(askSessionLabel(base, 1, "idle")).toBe("claude · 会话 2 · 空闲");
  });
  it("uses user titles, truncated", () => {
    expect(askSessionLabel({ ...base, titleSource: "user", title: "fix login" }, 0, undefined, "Claude")).toBe("Claude · fix login · 空闲");
    const long = askSessionLabel({ ...base, titleSource: "user", title: "x".repeat(40) }, 0, "idle");
    expect(long).toContain("…");
  });
  it("keeps Ask-named tabs and reports status", () => {
    expect(askSessionLabel({ ...base, title: "Ask · a.ts L3" }, 0, "working")).toBe("claude · Ask · a.ts L3 · 忙碌");
    expect(askSessionLabel({ ...base, status: "exited" }, 2, "idle")).toBe("claude · 会话 3 · 已退出");
  });
});

describe("askDraftKey", () => {
  it("keys by path and range", () => {
    expect(askDraftKey(ctx)).toBe("/repo/src/a.ts#3-5");
  });
});

describe("askPopoverPosition", () => {
  const vp = { width: 1000, height: 800 };
  const size = { width: 420, height: 200 };
  it("places below the anchor", () => {
    expect(askPopoverPosition({ top: 100, bottom: 120, left: 50 }, size, vp)).toEqual({ top: 126, left: 50, placement: "below" });
  });
  it("flips above when no room below", () => {
    const r = askPopoverPosition({ top: 700, bottom: 720, left: 50 }, size, vp);
    expect(r.placement).toBe("above");
    expect(r.top).toBe(494);
  });
  it("flips above the selection START line, not the end line", () => {
    const r = askPopoverPosition({ startTop: 640, top: 700, bottom: 720, left: 50 }, size, vp);
    expect(r.placement).toBe("above");
    expect(r.top).toBe(434);
    expect(r.top + size.height).toBeLessThanOrEqual(640);
  });
  it("clamps horizontally", () => {
    expect(askPopoverPosition({ top: 10, bottom: 20, left: 900 }, size, vp).left).toBe(572);
  });
});
