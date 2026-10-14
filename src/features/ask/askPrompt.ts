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
  /** Viewport rect of the selection's last line (popover anchor). */
  anchor?: AskAnchorRect | null;
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
  const lang = detectQuestionLanguage(question);
  lines.push(
    "",
    lang
      ? `Reply in the same language as the question below (${lang}).`
      : "Reply in the same language as the question below.",
    "Question:",
    question,
  );
  return lines.join("\n");
}

/** Best-effort language name for CJK questions; null = let the agent infer. */
export function detectQuestionLanguage(text: string): string | null {
  if (/[\u3040-\u30ff]/.test(text)) return "Japanese";
  if (/[\uac00-\ud7af]/.test(text)) return "Korean";
  if (/[\u4e00-\u9fff]/.test(text)) return "Chinese";
  return null;
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

export type AskSessionLabelTab = {
  title: string;
  status: "running" | "exited";
  agentId?: string;
  titleSource?: "default" | "user" | "inferred";
};

const SHORT_TITLE_MAX = 24;

/**
 * Readable session-selector label: `agent · title-or-index · status`.
 * Default/inferred titles are often the raw launch prompt, so fall back to
 * "会话 N" unless the user (or Ask itself) named the tab.
 */
export function askSessionLabel(
  tab: AskSessionLabelTab,
  index: number,
  activity: AgentActivityState | undefined,
  agentName?: string,
): string {
  const agent = agentName || tab.agentId || "agent";
  const raw = tab.title.replace(/\s+/g, " ").trim();
  const named = tab.titleSource === "user" || raw.startsWith("Ask ·");
  const short = named && raw
    ? raw.length > SHORT_TITLE_MAX
      ? `${raw.slice(0, SHORT_TITLE_MAX - 1)}…`
      : raw
    : `会话 ${index + 1}`;
  const status =
    tab.status === "exited"
      ? "已退出"
      : (activity ?? "idle") === "working"
        ? "忙碌"
        : "空闲";
  return `${agent} · ${short} · ${status}`;
}

/** Stable key so a draft survives close/reopen of the same selection. */
export function askDraftKey(ctx: Pick<AskContext, "path" | "startLine" | "endLine">): string {
  return `${ctx.path}#${ctx.startLine}-${ctx.endLine}`;
}

export type AskAnchorRect = {
  /** Top of the selection's last line. */
  top: number;
  /** Bottom of the selection's last line (below-placement anchor). */
  bottom: number;
  left: number;
  /** Top of the selection's first line (above-placement anchor). */
  startTop?: number;
};

/**
 * Place the popover below the anchor line; flip above when it doesn't fit.
 * Clamped horizontally into the viewport.
 */
export function askPopoverPosition(
  anchor: AskAnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8,
): { top: number; left: number; placement: "below" | "above" } {
  const belowTop = anchor.bottom + gap;
  const fitsBelow = belowTop + size.height <= viewport.height - margin;
  const aboveTop = (anchor.startTop ?? anchor.top) - gap - size.height;
  let placement: "below" | "above" = "below";
  let top = belowTop;
  if (!fitsBelow && aboveTop >= margin) {
    placement = "above";
    top = aboveTop;
  } else if (!fitsBelow) {
    top = Math.max(margin, viewport.height - margin - size.height);
  }
  const maxLeft = Math.max(margin, viewport.width - margin - size.width);
  const left = Math.min(Math.max(anchor.left, margin), maxLeft);
  return { top, left, placement };
}
