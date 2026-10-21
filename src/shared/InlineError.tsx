import { useState, type ReactNode } from "react";
import { formatError } from "./formatError";

export type InlineErrorProps = {
  error: unknown;
  className?: string;
  /** Optional full raw text for expand. Defaults to String(error). */
  details?: string;
  children?: ReactNode;
};

export function InlineError({
  error,
  className,
  details,
  children,
}: InlineErrorProps) {
  const [open, setOpen] = useState(false);
  const summary = formatError(error);
  const raw =
    details ??
    (error instanceof Error
      ? error.stack || error.message
      : error == null
        ? ""
        : String(error));
  const showDetails = Boolean(raw && raw.trim() && raw.trim() !== summary);

  return (
    <div
      className={`inline-error${className ? ` ${className}` : ""}`}
      role="alert"
    >
      <p className="inline-error__summary">{children ?? summary}</p>
      {showDetails ? (
        <button
          type="button"
          className="inline-error__toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide details" : "Show details"}
        </button>
      ) : null}
      {open && showDetails ? (
        <pre className="inline-error__details">{raw}</pre>
      ) : null}
    </div>
  );
}
