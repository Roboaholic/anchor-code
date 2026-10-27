import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@/shared/Icon";

export type MarkdownFindBarProps = {
  query: string;
  caseSensitive: boolean;
  matchCount: number;
  /** 0-based active index, or -1 when none. */
  activeIndex: number;
  /** Bump to re-focus and select the input (e.g. Ctrl+F while already open). */
  focusNonce?: number;
  onQueryChange: (query: string) => void;
  onCaseSensitiveChange: (value: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
};

/**
 * In-document find bar for Markdown rendered preview.
 * Mirrors files-search styling (theme tokens only, no native tooltips).
 */
export function MarkdownFindBar({
  query,
  caseSensitive,
  matchCount,
  activeIndex,
  focusNonce = 0,
  onQueryChange,
  onCaseSensitiveChange,
  onNext,
  onPrev,
  onClose,
}: MarkdownFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusNonce]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    // Ctrl/Cmd+G next, Shift+G prev — also handled at pane level; stop here when focused.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  const label =
    !query
      ? ""
      : matchCount === 0
        ? "No results"
        : `${activeIndex < 0 ? 0 : activeIndex + 1} of ${matchCount}`;

  return (
    <div className="md-find-bar" role="search" aria-label="Find in Markdown">
      <Icon name="search" className="md-find-bar__icon" />
      <input
        ref={inputRef}
        type="search"
        className="md-find-bar__input"
        placeholder="Find"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Find in document"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="md-find-bar__count" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        className={`icon-btn md-find-bar__toggle${caseSensitive ? " is-active" : ""}`}
        aria-label="Match case"
        aria-pressed={caseSensitive}
        data-tip="Match case"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        <Icon name="case-sensitive" />
      </button>
      <button
        type="button"
        className="icon-btn md-find-bar__nav"
        aria-label="Previous match"
        data-tip="Previous"
        disabled={matchCount === 0}
        onClick={onPrev}
      >
        <Icon name="arrow-up" />
      </button>
      <button
        type="button"
        className="icon-btn md-find-bar__nav"
        aria-label="Next match"
        data-tip="Next"
        disabled={matchCount === 0}
        onClick={onNext}
      >
        <Icon name="arrow-down" />
      </button>
      <button
        type="button"
        className="icon-btn md-find-bar__close"
        aria-label="Close find"
        data-tip="Close"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
