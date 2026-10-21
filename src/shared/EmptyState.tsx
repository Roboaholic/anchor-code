import type { ReactNode } from "react";
import { Icon, type CodiconName } from "./Icon";

export type EmptyStateProps = {
  icon?: CodiconName | (string & {});
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`empty-state${className ? ` ${className}` : ""}`}
      role="status"
    >
      {icon ? (
        <span className="empty-state__icon" aria-hidden>
          <Icon name={icon} />
        </span>
      ) : null}
      <p className="empty-state__title">{title}</p>
      {hint ? <p className="empty-state__hint muted">{hint}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
