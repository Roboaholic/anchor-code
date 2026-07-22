import { describe, expect, it } from "vitest";
import { buildAnchReviewExport } from "./exportFormat";
import type { SessionParsed } from "./sessionSchema";

const session: SessionParsed = {
  version: 1,
  id: "session_demo",
  title: "HITL review",
  status: "closed",
  created_at: "2026-07-19T12:00:00Z",
  ended_at: "2026-07-19T13:00:00Z",
  author: "local-user",
  notes: "",
  comments: [
    {
      id: "comment_1",
      status: "need_modify",
      target: {
        file_path: "src/app.ts",
        kind: "source",
        start_line: 2,
        end_line: 2,
        start_column: 18,
        end_column: 33,
        selected_text: "legacyTransform",
        before_context: "function buildPayload(input) {",
        after_context: "return normalize(result)",
        line_text: "  const result = legacyTransform(input)",
      },
      created_at: "2026-07-19T12:05:00Z",
      updated_at: "2026-07-19T12:10:00Z",
      author: "local-user",
      messages: [
        {
          id: "message_1",
          author: "local-user",
          created_at: "2026-07-19T12:05:00Z",
          body: "drop legacy path",
        },
        {
          id: "message_2",
          author: "local-user",
          created_at: "2026-07-19T12:10:00Z",
          body: "also update callers",
        },
      ],
    },
  ],
};

describe("buildAnchReviewExport", () => {
  it("matches anch-review export entry fields", () => {
    const payload = buildAnchReviewExport(session, "/repo", {
      "src/app.ts": {
        fileHash: "abc",
        gitCommitSha: "deadbeef",
      },
    });

    expect(payload.session).toMatchObject({
      id: "session_demo",
      title: "HITL review",
      status: "stopped",
      actor: "human",
      authorId: "local-user",
      workspaceRoot: "/repo",
      createdAt: "2026-07-19T12:00:00Z",
      stoppedAt: "2026-07-19T13:00:00Z",
    });

    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]).toMatchObject({
      sessionId: "session_demo",
      threadId: "comment_1",
      threadStatus: "active",
      reviewStatus: "needs_modify",
      commentId: "message_1",
      authorType: "human",
      authorId: "local-user",
      body: "drop legacy path",
      relativePath: "src/app.ts",
      startLine: 2,
      startColumn: 18,
      endLine: 2,
      endColumn: 33,
      selectedText: "legacyTransform",
      lineText: "  const result = legacyTransform(input)",
      contextBefore: ["function buildPayload(input) {"],
      contextAfter: ["return normalize(result)"],
      fileHash: "abc",
      gitCommitSha: "deadbeef",
    });
    expect(payload.entries[1]?.commentId).toBe("message_2");
  });
});
