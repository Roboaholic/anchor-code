/**
 * One-off "Ask" about a selection. Not persisted (unlike review comments).
 */
import type { AgentActivityState } from "@/features/terminal/terminalStore";

export type AskDiffContext = {
  repoRoot: string;
  branch?: string | null;
  base: string;
  head: string;
};

export type AskContext = {
  /** Absolute (or workspace-relative) file path. */
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  /** Present when asked from a diff view. */
  diff?: AskDiffContext | null;
};

export type AskPromptInput = {
  context: AskContext;
  question: string;
  readOnly: boolean;
};

const MAX_SNIPPET_CHARS = 8_000;

export function askLineLabel(ctx: Pick<AskContext, "startLine" | "endLine">): string {
  return ctx.startLine === ctx.endLine
    ? `L${ctx.startLine}`
    : `L${ctx.startLine}-${ctx.endLine}`;
}

/** Prompt sent as launch arg (new session) or bracketed paste (existing idle session). */
export function buildAskPrompt(input: AskPromptInput): string {
  const { context: ctx } = input;
  const question = input.question.trim();
  let snippet = ctx.snippet.replace(/\r\n/g, "\n");
  let clipped = false;
  if (snippet.length > MAX_SNIPPET_CHARS) {
    snippet = snippet.slice(0, MAX_SNIPPET_CHARS);
    clipped = true;
  }
  const lines: string[] = [
    "One-off question from Anchor Code about a selected code range.",
  ];
  if (input.readOnly) {
    lines.push(
      "Read-only: answer the question only. Do not edit, create, or delete files, and do not run commands that change state.",
    );
  }
  lines.push("", `File: ${ctx.path}`, `Lines: ${askLineLabel(ctx)}`);
  if (ctx.diff) {
    lines.push(
      `Diff: repo ${ctx.diff.repoRoot}${ctx.diff.branch ? ` (branch ${ctx.diff.branch})` : ""}, base ${ctx.diff.base}, head ${ctx.diff.head}`,
    );
  }
  lines.push("", "Selected code:", "```", snippet, "```");
  if (clipped) lines.push(`(snippet clipped to ${MAX_SNIPPET_CHARS} chars)`);
  lines.push("", "Question:", question);
  return lines.join("\n");
}

/** Only idle (or finished-but-unread) running agent sessions can take an Ask. */
export function isAskSessionSelectable(
  tab: { status: "running" | "exited"; kind?: string },
  activity: AgentActivityState | undefined,
): boolean {
  if ((tab.kind ?? "shell") !== "agent") return false;
  if (tab.status !== "running") return false;
  return (activity ?? "idle") !== "working";
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Bracketed paste body + submit key, written as two PTY writes so TUIs treat
 * the multi-line prompt as one paste and Enter as a submit.
 */
export function askPasteChunks(prompt: string): [string, string] {
  // Strip any embedded paste terminators so the prompt can't break out.
  const safe = prompt.split(PASTE_END).join("").split(PASTE_START).join("");
  return [`${PASTE_START}${safe}${PASTE_END}`, "\r"];
}
