/**
 * Map anchor-code session YAML → anch-review export JSON shape.
 * Consumers (AI backends) already know this layout from anch-review CLI.
 */

import type { SessionParsed } from "./sessionSchema";

export type AnchReviewExportPayload = {
  session: {
    id: string;
    title: string;
    status: string;
    actor: string;
    authorId: string;
    workspaceRoot: string;
    createdAt: string;
    stoppedAt: string | null;
  };
  entries: AnchReviewExportEntry[];
};

export type AnchReviewExportEntry = {
  sessionId: string;
  sessionTitle: string;
  threadId: string;
  threadStatus: "active" | "resolved";
  reviewStatus: "discussing" | "needs_modify" | "closed";
  commentId: string;
  authorType: "human" | "ai";
  authorId: string;
  body: string;
  createdAt: string;
  relativePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  lineText: string;
  selectedText: string;
  contextBefore: string[];
  contextAfter: string[];
  fileHash: string | null;
  gitCommitSha: string | null;
};

function mapReviewStatus(
  status: string,
): "discussing" | "needs_modify" | "closed" {
  if (status === "need_modify" || status === "needs_modify") {
    return "needs_modify";
  }
  if (status === "closed") return "closed";
  return "discussing";
}

function contextLines(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

function lineTextOf(target: {
  selected_text: string;
  line_text?: string;
}): string {
  if (target.line_text && target.line_text.length > 0) {
    return target.line_text;
  }
  const first = target.selected_text.split(/\r?\n/)[0];
  return first ?? "";
}

/**
 * Build anch-review-compatible export. Optional per-file metadata
 * (hash / commit) can be injected via `metaByPath`.
 */
export function buildAnchReviewExport(
  session: SessionParsed,
  workspaceRoot: string,
  metaByPath: Record<
    string,
    { fileHash?: string | null; gitCommitSha?: string | null }
  > = {},
): AnchReviewExportPayload {
  const sessionStatus = session.status === "closed" ? "stopped" : session.status;

  const entries: AnchReviewExportEntry[] = [];
  for (const comment of session.comments) {
    const anchor = comment.target;
    const rel = anchor.file_path.replace(/\\/g, "/");
    const meta = metaByPath[rel] ?? {};
    const reviewStatus = mapReviewStatus(comment.status);
    const threadStatus: "active" | "resolved" =
      reviewStatus === "closed" ? "resolved" : "active";

    for (const msg of comment.messages) {
      entries.push({
        sessionId: session.id,
        sessionTitle: session.title,
        threadId: comment.id,
        threadStatus,
        reviewStatus,
        commentId: msg.id,
        authorType: "human",
        authorId: msg.author || session.author || "local-user",
        body: msg.body,
        createdAt: msg.created_at,
        relativePath: rel,
        startLine: anchor.start_line,
        startColumn: Math.max(1, anchor.start_column),
        endLine: anchor.end_line,
        endColumn: Math.max(1, anchor.end_column),
        lineText: lineTextOf(anchor),
        selectedText: anchor.selected_text,
        contextBefore: contextLines(anchor.before_context),
        contextAfter: contextLines(anchor.after_context),
        fileHash: meta.fileHash ?? null,
        gitCommitSha: meta.gitCommitSha ?? null,
      });
    }
  }

  return {
    session: {
      id: session.id,
      title: session.title,
      status: sessionStatus,
      actor: "human",
      authorId: session.author || "local-user",
      workspaceRoot,
      createdAt: session.created_at,
      stoppedAt: session.ended_at,
    },
    entries,
  };
}
