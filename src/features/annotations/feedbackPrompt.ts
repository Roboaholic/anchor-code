/**
 * Hidden default prompt for Comments → Feedback → Agent launch.
 * Shown to the agent CLI only; never rendered in the UI.
 */

export type FeedbackPromptInput = {
  yamlPath: string;
  exportPath?: string | null;
  additionalNotes?: string | null;
  /** Author string for messages[] written back to session YAML. */
  agentAuthor?: string | null;
};

/** Stable YAML author from the selected CLI profile (not a hard-coded product name). */
export function agentAuthorFromProfile(profile: {
  id?: string | null;
  name?: string | null;
}): string {
  const name = profile.name?.trim();
  if (name) return name;
  const id = profile.id?.trim();
  if (id) return id;
  return "agent";
}

export function buildFeedbackPrompt(input: FeedbackPromptInput): string {
  const yamlPath = input.yamlPath.trim();
  const exportPath = input.exportPath?.trim() || "";
  const notes = input.additionalNotes?.trim() || "";
  const agentAuthor = (input.agentAuthor ?? "").trim() || "agent";

  const lines = [
    "You are applying Anchor Code review feedback for one session.",
    "Use the anchor-review skill for the workflow and status rules.",
    "",
    "Primary source (session YAML, source of truth):",
    yamlPath,
  ];

  if (exportPath) {
    lines.push("", "Optional export JSON (same session, flattened):", exportPath);
  }

  lines.push(
    "",
    "Author identity:",
    `- When appending messages[] to the session YAML, set author exactly to: ${agentAuthor}`,
    "- Do not invent authors like grok-agent / claude / codex unless that is the exact string above.",
    "",
    "Goals:",
    "- Read open comments; prioritize need_modify / needs_modify.",
    "- Reply when clarifying is needed (discussing).",
    "- Implement concrete change requests.",
    "- Update comment statuses in the session YAML (closed when done).",
    "- Report which comment ids you closed, what files changed, and what remains open.",
    "",
    "Language:",
    "- Match the language of each human comment thread when replying or writing",
      "  messages back into the session YAML (e.g. Chinese comments → Chinese replies).",
    "- If a thread mixes languages, follow the latest human message.",
    "- Keep code identifiers, paths, and CLI output as-is.",
    "",
    "Do not restate this instruction block. Do the work.",
  );

  if (notes) {
    lines.push("", "Additional instructions from the human:", notes);
  }

  return lines.join("\n");
}

export function feedbackTabTitle(sessionTitle: string): string {
  const t = sessionTitle.trim() || "session";
  const short = t.length > 48 ? `${t.slice(0, 45)}…` : t;
  return `Feedback · ${short}`;
}

export function countOpenFeedbackComments(
  comments: Array<{ status: string }>,
): { open: number; needModify: number } {
  let open = 0;
  let needModify = 0;
  for (const c of comments) {
    if (c.status === "need_modify" || c.status === "needs_modify") {
      open += 1;
      needModify += 1;
    } else if (c.status === "discussing") {
      open += 1;
    }
  }
  return { open, needModify };
}

export function isAnchorReviewInstalled(status: {
  targets: Array<{ installed: boolean }>;
}): boolean {
  return status.targets.some((t) => t.installed);
}
