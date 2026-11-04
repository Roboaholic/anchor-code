import type { HTMLAttributes, ReactNode } from "react";
import type { SnapshotMeta } from "@/shared/anchor-api";

export type TagTone = "muted" | "accent" | "ok" | "warn" | "neutral" | "danger";

/** Text variant of the Git changes "M" tile (`.repo-row__badge`). */
export function StatusTag({
  tone = "muted",
  className,
  children,
  ...rest
}: { tone?: TagTone; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  const cls = ["repo-row__badge", "repo-row__badge--text", tone === "muted" ? "" : `repo-row__badge--${tone}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}

/** Owner of a snapshot: 你 / auto / agent name, each with its own tint. */
export function ownerTag(s: Pick<SnapshotMeta, "source" | "agentLabel">): { label: string; tone: TagTone } {
  if (s.agentLabel) {
    const l = s.agentLabel.toLowerCase();
    return { label: s.agentLabel, tone: l.includes("codex") ? "ok" : l.includes("claude") ? "warn" : "neutral" };
  }
  if (s.source === "manual") return { label: "你", tone: "accent" };
  return { label: "auto", tone: "muted" };
}
