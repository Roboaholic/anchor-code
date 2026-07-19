import { z } from "zod";

/** Zod schema for session YAML (unique source of truth on disk). */

export const commentStatusSchema = z.enum([
  "discussing",
  "need_modify",
  "closed",
]);

export const sessionStatusSchema = z.enum(["active", "closed"]);

export const messageSchema = z.object({
  id: z.string().min(1),
  author: z.string(),
  created_at: z.string(),
  body: z.string(),
});

export const targetSchema = z.object({
  file_path: z.string().min(1),
  kind: z.enum(["source", "markdown"]),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  start_column: z.number().int().nonnegative(),
  end_column: z.number().int().nonnegative(),
  selected_text: z.string(),
  before_context: z.string(),
  after_context: z.string(),
});

export const commentSchema = z.object({
  id: z.string().min(1),
  status: commentStatusSchema,
  target: targetSchema,
  created_at: z.string(),
  updated_at: z.string(),
  author: z.string(),
  messages: z.array(messageSchema).min(1),
});

export const sessionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  title: z.string(),
  status: sessionStatusSchema,
  created_at: z.string(),
  ended_at: z.string().nullable(),
  author: z.string(),
  notes: z.string(),
  comments: z.array(commentSchema),
});

export type SessionParsed = z.infer<typeof sessionSchema>;

export function parseSession(raw: unknown): SessionParsed {
  return sessionSchema.parse(raw);
}

export function safeParseSession(raw: unknown) {
  return sessionSchema.safeParse(raw);
}

/**
 * At most one active session per repo. Returns the active one or null.
 * Throws if multiple actives (corrupt on-disk state).
 */
export function selectActiveSession<T extends { status: string }>(
  sessions: T[],
): T | null {
  const actives = sessions.filter((s) => s.status === "active");
  if (actives.length > 1) {
    throw new Error(
      "Multiple active sessions found. Keep one active in .anchor-code/ YAML.",
    );
  }
  return actives[0] ?? null;
}

/** Relative path of file under repoRoot (POSIX separators). */
export function toRepoRelative(repoRoot: string, filePath: string): string {
  const r = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = filePath.replace(/\\/g, "/");
  if (f === r) return "";
  if (f.startsWith(r + "/")) return f.slice(r.length + 1);
  // already relative-ish
  if (!f.startsWith("/") && !/^[A-Za-z]:/.test(f)) {
    return f.replace(/\\/g, "/");
  }
  return f;
}
