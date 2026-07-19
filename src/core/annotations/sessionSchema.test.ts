import { describe, expect, it } from "vitest";
import {
  parseSession,
  safeParseSession,
  selectActiveSession,
  toRepoRelative,
} from "./sessionSchema";

const validSession = {
  version: 1 as const,
  id: "session_2026_07_19_hitl",
  title: "HITL review",
  status: "active" as const,
  created_at: "2026-07-19T12:00:00Z",
  ended_at: null,
  author: "local-user",
  notes: "",
  comments: [
    {
      id: "comment_001",
      status: "discussing" as const,
      target: {
        file_path: "src/app.ts",
        kind: "source" as const,
        start_line: 42,
        end_line: 48,
        start_column: 3,
        end_column: 18,
        selected_text: "const result = legacyTransform(input)",
        before_context: "function buildPayload(input) {",
        after_context: "return normalize(result)",
      },
      created_at: "2026-07-19T12:05:00Z",
      updated_at: "2026-07-19T12:05:00Z",
      author: "local-user",
      messages: [
        {
          id: "message_001",
          author: "local-user",
          created_at: "2026-07-19T12:05:00Z",
          body: "这里不应再走 legacy。",
        },
      ],
    },
  ],
};

describe("sessionSchema", () => {
  it("accepts a valid v1 session", () => {
    const s = parseSession(validSession);
    expect(s.id).toBe("session_2026_07_19_hitl");
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]!.messages[0]!.body).toContain("legacy");
  });

  it("rejects wrong version", () => {
    const r = safeParseSession({ ...validSession, version: 2 });
    expect(r.success).toBe(false);
  });

  it("rejects missing comment messages", () => {
    const bad = {
      ...validSession,
      comments: [
        {
          ...validSession.comments[0]!,
          messages: [],
        },
      ],
    };
    expect(safeParseSession(bad).success).toBe(false);
  });

  it("rejects invalid comment status", () => {
    const bad = {
      ...validSession,
      comments: [
        {
          ...validSession.comments[0]!,
          status: "open",
        },
      ],
    };
    expect(safeParseSession(bad).success).toBe(false);
  });
});

describe("selectActiveSession", () => {
  it("returns the single active session", () => {
    const sessions = [
      { id: "a", status: "closed" },
      { id: "b", status: "active" },
    ];
    expect(selectActiveSession(sessions)?.id).toBe("b");
  });

  it("returns null when none active", () => {
    expect(selectActiveSession([{ id: "a", status: "closed" }])).toBeNull();
  });

  it("throws when multiple actives", () => {
    expect(() =>
      selectActiveSession([
        { id: "a", status: "active" },
        { id: "b", status: "active" },
      ]),
    ).toThrow(/Multiple active/);
  });
});

describe("toRepoRelative", () => {
  it("strips repo root prefix", () => {
    expect(toRepoRelative("/home/u/proj", "/home/u/proj/src/a.ts")).toBe(
      "src/a.ts",
    );
  });

  it("handles already-relative paths", () => {
    expect(toRepoRelative("/home/u/proj", "src/a.ts")).toBe("src/a.ts");
  });

  it("normalizes backslashes", () => {
    expect(toRepoRelative("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src/a.ts");
  });
});
