// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import type { SessionRecord } from "@/shared/anchor-api";
import { useAnnotationsStore } from "./annotationsStore";
import { CommentsPane } from "./CommentsPane";

const { jumpToComment } = vi.hoisted(() => ({ jumpToComment: vi.fn(async () => {}) }));
vi.mock("@/features/shell/orchestrate", () => ({ jumpToComment }));

const session: SessionRecord = {
  version: 1, id: "session-a", title: "Review", status: "active", created_at: "now", ended_at: null,
  author: "reviewer", notes: "", comments: [{
    id: "comment-a", status: "discussing", author: "reviewer", created_at: "now", updated_at: "now",
    messages: [{ id: "message-a", author: "reviewer", created_at: "now", body: "Check this selection" }],
    target: {
      file_path: "a.ts", kind: "source", start_line: 1, end_line: 2,
      start_column: 1, end_column: 1, selected_text: "first\n", before_context: "", after_context: "",
    },
  }],
};

beforeEach(() => {
  jumpToComment.mockClear();
  useWorkspaceStore.setState({ workspaceRoot: "/repo" });
  useAnnotationsStore.setState({
    ...useAnnotationsStore.getInitialState(), repoRoot: "/repo", sessions: [session],
    activeSession: session, expandedSessionId: session.id,
  }, true);
});
afterEach(cleanup);

describe("comment card navigation", () => {
  it("navigates once when the location button is clicked inside the card", () => {
    render(<CommentsPane />);
    fireEvent.click(screen.getByTitle("a.ts:1"));
    expect(jumpToComment).toHaveBeenCalledTimes(1);
    expect(jumpToComment).toHaveBeenCalledWith(session.comments[0], session.id);
  });
});
