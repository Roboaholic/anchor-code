import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export type DisclosureProps = {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
};

/** Themed collapsible section replacing native &lt;details&gt;. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div
      className={`anchor-disclosure${open ? " is-open" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <button
        type="button"
        className="anchor-disclosure__summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon
          name="chevron-right"
          className="anchor-disclosure__chevron"
        />
        <span className="anchor-disclosure__label">{summary}</span>
      </button>
      {open ? (
        <div id={panelId} className="anchor-disclosure__panel" role="region">
          {children}
        </div>
      ) : null}
    </div>
  );
}
