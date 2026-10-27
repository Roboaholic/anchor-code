import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { dropdownMenuPosition, nextEnabledIndex } from "./Dropdown";

export interface ComboboxOption {
  value: string;
  /** Primary label; defaults to `value`. */
  label?: ReactNode;
  textValue?: string;
  /** Secondary muted text (e.g. config path). */
  hint?: ReactNode;
  disabled?: boolean;
}

export interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  menuClassName?: string;
  /** Called when an option is picked from the list (after onChange). */
  onSelectOption?: (value: string) => void;
  autoCapitalize?: string;
  spellCheck?: boolean;
  "data-testid"?: string;
}

const MENU_ATTR = "data-anchor-dropdown-menu";
const VIEWPORT_MARGIN = 8;

let openCount = 0;

/** True while any themed combobox menu is open. */
export function isComboboxOpen(): boolean {
  return openCount > 0;
}

function optionText(o: ComboboxOption): string {
  if (o.textValue) return o.textValue;
  if (typeof o.label === "string" || typeof o.label === "number") return String(o.label);
  return o.value;
}

function firstEnabled(options: ComboboxOption[], dir: 1 | -1): number {
  const start = dir === 1 ? -1 : options.length;
  const idx = nextEnabledIndex(options, start, dir);
  return idx === start ? -1 : idx;
}

/**
 * Editable combobox: free typing plus a themed, portaled suggestion list.
 * Reuses dropdown menu tokens/positioning so it matches shared Dropdown.
 *
 * Enter with a highlighted option accepts it; Enter with no highlight closes
 * the list and lets a surrounding form submit (same as the old datalist field).
 */
export function Combobox({
  value,
  onChange,
  options,
  disabled = false,
  placeholder,
  id,
  className,
  menuClassName,
  onSelectOption,
  autoCapitalize,
  spellCheck,
  ...aria
}: ComboboxProps) {
  const reactId = useId();
  const baseId = id ?? `cb-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const listboxId = `${baseId}-listbox`;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [browseAll, setBrowseAll] = useState(false);
  const [active, setActive] = useState(-1);
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const filtered = useMemo(() => {
    if (browseAll) return options;
    const q = value.trim().toLowerCase();
    if (!q) return options;
    const matched = options.filter((o) => optionText(o).toLowerCase().includes(q));
    // Keep the menu useful while typing a known prefix; fall back to full list
    // when nothing matches so free typing still has the full host catalog.
    return matched.length > 0 ? matched : options;
  }, [browseAll, options, value]);

  const close = useCallback(() => {
    setOpen(false);
    setStyle(null);
    setActive(-1);
    setBrowseAll(false);
  }, []);

  const openMenu = useCallback(
    (initial = -1, opts?: { browseAll?: boolean }) => {
      if (disabled || options.length === 0) return;
      // Leave active at -1 unless the caller (arrow keys) picks one, so Enter
      // can still submit a surrounding form when the user has not navigated.
      if (opts?.browseAll) setBrowseAll(true);
      setActive(initial);
      setOpen(true);
    },
    [disabled, options.length],
  );

  const commit = useCallback(
    (index: number) => {
      const option = filtered[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      onSelectOption?.(option.value);
      close();
      inputRef.current?.focus();
    },
    [close, filtered, onChange, onSelectOption],
  );

  useEffect(() => {
    if (!open) return;
    openCount += 1;
    return () => {
      openCount -= 1;
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) close();
  }, [close, disabled, open]);

  const place = useCallback(() => {
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;
    const r = wrap.getBoundingClientRect();
    const width = Math.min(
      Math.max(r.width, menu.scrollWidth),
      window.innerWidth - VIEWPORT_MARGIN * 2,
    );
    const pos = dropdownMenuPosition(
      { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
      { width, height: menu.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setStyle((prev) => {
      const next: CSSProperties = {
        top: pos.top,
        left: pos.left,
        minWidth: r.width,
        maxWidth: window.innerWidth - VIEWPORT_MARGIN * 2,
        maxHeight: pos.maxHeight,
      };
      return prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.minWidth === next.minWidth &&
        prev.maxHeight === next.maxHeight
        ? prev
        : next;
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      place();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [close, open, place]);

  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, style]);

  // Keep active index in range as the filter shrinks; do not auto-highlight.
  useEffect(() => {
    if (!open) return;
    setActive((cur) => {
      if (cur < 0) return -1;
      if (cur < filtered.length && !filtered[cur]?.disabled) return cur;
      return -1;
    });
  }, [filtered, open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const key = e.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        openMenu(key === "ArrowDown" ? firstEnabled(filtered, 1) : firstEnabled(filtered, -1));
        return;
      }
      if (key === "Escape") return;
      return;
    }
    switch (key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        e.stopPropagation();
        const dir = key === "ArrowDown" ? 1 : -1;
        setActive((cur) => (cur < 0 ? firstEnabled(filtered, dir) : nextEnabledIndex(filtered, cur, dir)));
        return;
      }
      case "Enter": {
        if (active >= 0 && filtered[active] && !filtered[active].disabled) {
          e.preventDefault();
          e.stopPropagation();
          commit(active);
          return;
        }
        // No highlighted option → close suggestions and let the form handle Enter.
        close();
        return;
      }
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation?.();
        close();
        return;
      case "Tab":
        close();
        return;
      default:
        break;
    }
  };

  const activeId = open && active >= 0 ? `${baseId}-opt-${active}` : undefined;
  const showMenu = open && filtered.length > 0;

  return (
    <>
      <div
        ref={wrapRef}
        className={`combobox${showMenu ? " is-open" : ""}${disabled ? " is-disabled" : ""}${
          className ? ` ${className}` : ""
        }`}
      >
        <input
          ref={inputRef}
          id={baseId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={showMenu}
          aria-controls={showMenu ? listboxId : undefined}
          aria-activedescendant={activeId}
          aria-label={aria["aria-label"]}
          aria-labelledby={aria["aria-labelledby"]}
          data-testid={aria["data-testid"]}
          className="combobox__input"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          autoCapitalize={autoCapitalize}
          spellCheck={spellCheck}
          autoComplete="off"
          onChange={(event) => {
            setBrowseAll(false);
            onChange(event.target.value);
            if (options.length > 0) openMenu();
          }}
          onFocus={() => {
            if (!disabled && options.length > 0) openMenu();
          }}
          onClick={() => {
            if (!open && !disabled && options.length > 0) openMenu();
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="combobox__toggle"
          tabIndex={-1}
          disabled={disabled || options.length === 0}
          aria-label="Show host suggestions"
          aria-expanded={showMenu}
          onMouseDown={(e) => {
            // Keep focus on the input; toggle the menu.
            e.preventDefault();
          }}
          onClick={() => {
            if (showMenu) close();
            else {
              openMenu(-1, { browseAll: true });
              inputRef.current?.focus();
            }
          }}
        >
          <Icon name="chevron-down" className="combobox__chevron" />
        </button>
      </div>
      {showMenu
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              role="listbox"
              aria-label={aria["aria-label"] ?? "Host suggestions"}
              tabIndex={-1}
              {...{ [MENU_ATTR]: "" }}
              className={`dropdown-menu${menuClassName ? ` ${menuClassName}` : ""}`}
              style={{
                ...(style ?? { top: -9999, left: -9999 }),
                visibility: style ? "visible" : "hidden",
              }}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
            >
              {filtered.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <div
                    key={option.value}
                    id={`${baseId}-opt-${index}`}
                    role="option"
                    data-index={index}
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    className={`dropdown-menu__option${isSelected ? " is-selected" : ""}${
                      index === active ? " is-active" : ""
                    }${option.disabled ? " is-disabled" : ""}`}
                    onMouseMove={() => {
                      if (!option.disabled && index !== active) setActive(index);
                    }}
                    onClick={() => commit(index)}
                  >
                    <span className="dropdown-menu__check" aria-hidden>
                      {isSelected ? <Icon name="check" /> : null}
                    </span>
                    <span className="dropdown-menu__label">{option.label ?? option.value}</span>
                    {option.hint ? <span className="dropdown-menu__hint">{option.hint}</span> : null}
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
