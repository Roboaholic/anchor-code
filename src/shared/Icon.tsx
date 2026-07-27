/**
 * VS Code Codicons — use class "codicon codicon-<name>".
 * @see https://microsoft.github.io/vscode-codicons/dist/codicon.html
 */
import type { HTMLAttributes } from "react";

export type CodiconName =
  | "add"
  | "close"
  | "comment"
  | "comment-discussion"
  | "copy"
  | "diff"
  | "error"
  | "edit"
  | "trash"
  | "export"
  | "file"
  | "file-code"
  | "files"
  | "folder"
  | "folder-opened"
  | "git-branch"
  | "history"
  | "home"
  | "json"
  | "layout-sidebar-left"
  | "layout-sidebar-right"
  | "list-flat"
  | "markdown"
  | "refresh"
  | "robot"
  | "search"
  | "settings-gear"
  | "symbol-file"
  | "terminal"
  | "chevron-down"
  | "chevron-right"
  | "regex"
  | "case-sensitive"
  | "filter";
type IconProps = {
  name: CodiconName | (string & {});
  className?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">;

export function Icon({ name, className, ...rest }: IconProps) {
  const classes = ["codicon", `codicon-${name}`, className]
    .filter(Boolean)
    .join(" ");
  return <span className={classes} aria-hidden {...rest} />;
}
