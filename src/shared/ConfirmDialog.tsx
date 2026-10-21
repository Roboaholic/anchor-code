import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ConfirmOptions = {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use danger styling on the confirm button. */
  danger?: boolean;
};

type Pending = ConfirmOptions & {
  resolve: (ok: boolean) => void;
};

let externalAsk: ((options: ConfirmOptions) => Promise<boolean>) | null = null;

/** Imperative confirm used outside React trees (same as window.confirm). */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!externalAsk) {
    // Fallback when the host is not mounted (tests / early boot).
    return Promise.resolve(
      typeof window !== "undefined"
        ? window.confirm(
            typeof options.message === "string"
              ? options.message
              : options.title,
          )
        : false,
    );
  }
  return externalAsk(options);
}

/**
 * Mount once near the app root. Renders a themed modal and wires
 * {@link confirmDialog}.
 */
export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    externalAsk = (options) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...options, resolve });
      });
    return () => {
      externalAsk = null;
    };
  }, []);

  const close = useCallback((ok: boolean) => {
    setPending((cur) => {
      cur?.resolve(ok);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => confirmRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Enter" && !e.isComposing) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "TEXTAREA" || tag === "BUTTON") return;
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [pending, close]);

  if (!pending) return null;

  return createPortal(
    <div
      className="modal-backdrop confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            {pending.title}
          </h2>
        </header>
        <p id={descId} className="modal__hint confirm-dialog__message">
          {pending.message}
        </p>
        <div className="modal__footer confirm-dialog__footer">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => close(false)}
          >
            {pending.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${pending.danger ? "btn--danger" : "btn--fill"}`}
            onClick={() => close(true)}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
