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

export interface DropdownOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Plain text used for type-ahead and the trigger tooltip. Defaults to `label` when it is a string. */
  textValue?: string;
  disabled?: boolean;
  title?: string;
  /** Secondary, muted text shown at the end of the option row. */
  hint?: ReactNode;
}

export interface DropdownGroup<V extends string = string> {
  /** Non-selectable group header; omit for an unlabelled group. */
  label?: ReactNode;
  options: DropdownOption<V>[];
}

export interface DropdownProps<V extends string = string> {
  value: V;
  onChange: (value: V) => void;
  /** Flat options; ignored when `groups` is given. */
  options?: DropdownOption<V>[];
  /** Grouped options with optional headers. */
  groups?: DropdownGroup<V>[];
  disabled?: boolean;
  /** Trigger text when `value` matches no option. */
  placeholder?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  id?: string;
  title?: string;
  /** Extra class for the trigger button. */
  className?: string;
  /** Extra class for the floating listbox. */
  menuClassName?: string;
  size?: "sm" | "md";
  /** Minimum menu width in px (defaults to the trigger width). */
  minMenuWidth?: number;
  "data-testid"?: string;
}

const MENU_ATTR = "data-anchor-dropdown-menu";
const VIEWPORT_MARGIN = 8;
const MAX_MENU_HEIGHT = 300;
const TYPEAHEAD_RESET_MS = 600;

let openCount = 0;

/** True while any themed dropdown menu is open (for global Escape handlers). */
export function isDropdownOpen(): boolean {
  return openCount > 0;
}

/**
 * The listbox is portaled to <body>, so popovers that close on outside
 * clicks / wheel must treat it as part of themselves.
 */
export function isInsideDropdownMenu(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(`[${MENU_ATTR}]`);
}

type FlatItem<V extends string> = { option: DropdownOption<V>; index: number };

export function optionText(o: DropdownOption): string {
  if (o.textValue) return o.textValue;
  return typeof o.label === "string" || typeof o.label === "number" ? String(o.label) : o.value;
}

/** Next enabled index from `from` in direction `dir`; stays put at the ends. */
export function nextEnabledIndex(
  options: Array<{ disabled?: boolean }>,
  from: number,
  dir: 1 | -1,
  steps = 1,
): number {
  let idx = from;
  let found = from;
  let remaining = steps;
  while (remaining > 0) {
    idx += dir;
    if (idx < 0 || idx >= options.length) break;
    if (!options[idx].disabled) {
      found = idx;
      remaining -= 1;
    }
  }
  return found;
}

function firstEnabled(options: Array<{ disabled?: boolean }>, dir: 1 | -1): number {
  const start = dir === 1 ? -1 : options.length;
  const idx = nextEnabledIndex(options, start, dir);
  return idx === start ? -1 : idx;
}

/** Viewport placement for the menu: below the trigger, flipped above when it fits better. */
export function dropdownMenuPosition(
  trigger: { top: number; bottom: number; left: number; width: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; maxHeight: number; placement: "below" | "above" } {
  const below = viewport.height - trigger.bottom - VIEWPORT_MARGIN - 4;
  const above = trigger.top - VIEWPORT_MARGIN - 4;
  const wanted = Math.min(menu.height, MAX_MENU_HEIGHT);
  // Prefer opening downwards (like a native select) whenever a usefully
  // tall, scrollable list fits; flip only when space below is really tight.
  const placement = below >= wanted || below >= Math.min(wanted, 200) || below >= above ? "below" : "above";
  const maxHeight = Math.max(80, Math.min(MAX_MENU_HEIGHT, placement === "below" ? below : above));
  const height = Math.min(menu.height, maxHeight);
  const top = placement === "below" ? trigger.bottom + 4 : trigger.top - 4 - height;
  const maxLeft = viewport.width - VIEWPORT_MARGIN - menu.width;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(trigger.left, maxLeft));
  return { top, left, maxHeight, placement };
}

/**
 * Themed replacement for native <select> (select-only combobox pattern).
 * Focus stays on the trigger; the listbox is portaled and positioned inside
 * the viewport. Keys: ↑/↓/Home/End/PageUp/PageDown move, Enter/Space pick,
 * Esc/Tab close, printable keys type-ahead.
 */
export function Dropdown<V extends string = string>({
  value,
  onChange,
  options,
  groups,
  disabled = false,
  placeholder = "Select…",
  id,
  title,
  className,
  menuClassName,
  size = "md",
  minMenuWidth,
  ...aria
}: DropdownProps<V>) {
  const reactId = useId();
  const baseId = id ?? `dd-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const listboxId = `${baseId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const typeahead = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const resolvedGroups = useMemo<DropdownGroup<V>[]>(
    () => groups ?? [{ options: options ?? [] }],
    [groups, options],
  );
  const flat = useMemo(() => {
    const out: FlatItem<V>[] = [];
    for (const g of resolvedGroups) for (const option of g.options) out.push({ option, index: out.length });
    return out;
  }, [resolvedGroups]);
  const flatOptions = useMemo(() => flat.map((f) => f.option), [flat]);
  const selectedIndex = flatOptions.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? flatOptions[selectedIndex] : undefined;
  const isDisabled = disabled || flatOptions.length === 0;

  const close = useCallback(() => {
    setOpen(false);
    setStyle(null);
  }, []);

  const openMenu = useCallback(
    (initial?: number) => {
      if (isDisabled) return;
      const start =
        initial ??
        (selectedIndex >= 0 && !flatOptions[selectedIndex]?.disabled
          ? selectedIndex
          : firstEnabled(flatOptions, 1));
      setActive(start);
      setOpen(true);
    },
    [flatOptions, isDisabled, selectedIndex],
  );

  const commit = useCallback(
    (index: number) => {
      const option = flatOptions[index];
      if (!option || option.disabled) return;
      close();
      if (option.value !== value) onChange(option.value);
    },
    [close, flatOptions, onChange, value],
  );

  useEffect(() => {
    if (!open) return;
    openCount += 1;
    return () => {
      openCount -= 1;
    };
  }, [open]);

  useEffect(() => {
    if (isDisabled && open) close();
  }, [close, isDisabled, open]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const r = trigger.getBoundingClientRect();
    const width = Math.min(
      Math.max(r.width, minMenuWidth ?? 0, menu.scrollWidth),
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
        minWidth: Math.max(r.width, minMenuWidth ?? 0),
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
  }, [minMenuWidth]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, flat.length]);

  // Outside press closes; scrolling elsewhere / resizing re-anchors.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
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

  // Keep the active option visible.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, style]);

  const runTypeahead = (key: string): number => {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key;
    state.at = now;
    const needle = state.text.toLowerCase();
    const from = open ? active : selectedIndex;
    const n = flatOptions.length;
    // Same key repeated cycles through matches; otherwise match from current.
    const single = needle.split("").every((c) => c === needle[0]);
    const query = single ? needle[0] : needle;
    const startOffset = single || from < 0 ? 1 : 0;
    for (let i = 0; i < n; i += 1) {
      const idx = (Math.max(from, 0) + startOffset + i) % n;
      const o = flatOptions[idx];
      if (!o.disabled && optionText(o).toLowerCase().replace(/^[+\s]+/, "").startsWith(query)) return idx;
    }
    return -1;
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    const key = e.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        e.preventDefault();
        e.stopPropagation();
        openMenu();
        return;
      }
      if (key === "Home" || key === "End") {
        e.preventDefault();
        openMenu(firstEnabled(flatOptions, key === "Home" ? 1 : -1));
        return;
      }
      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const idx = runTypeahead(key);
        if (idx >= 0) {
          e.preventDefault();
          openMenu(idx);
        }
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey && key === "ArrowUp") {
          commit(active);
          return;
        }
        const dir = key === "ArrowDown" ? 1 : -1;
        setActive((cur) => (cur < 0 ? firstEnabled(flatOptions, dir) : nextEnabledIndex(flatOptions, cur, dir)));
        return;
      }
      case "PageDown":
      case "PageUp": {
        e.preventDefault();
        const dir = key === "PageDown" ? 1 : -1;
        setActive((cur) => nextEnabledIndex(flatOptions, cur < 0 ? (dir === 1 ? -1 : flatOptions.length) : cur, dir, 10));
        return;
      }
      case "Home":
      case "End":
        e.preventDefault();
        setActive(firstEnabled(flatOptions, key === "Home" ? 1 : -1));
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        if (active >= 0) commit(active);
        else close();
        return;
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
        if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const idx = runTypeahead(key);
          if (idx >= 0) {
            e.preventDefault();
            setActive(idx);
          }
        }
    }
  };

  const activeId = open && active >= 0 ? `${baseId}-opt-${active}` : undefined;
  const triggerTitle = title ?? (selected ? selected.title ?? optionText(selected) : undefined);

  return (
    <>
      <button
        ref={triggerRef}
        id={baseId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeId}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        data-testid={aria["data-testid"]}
        disabled={isDisabled}
        title={triggerTitle}
        className={`dropdown dropdown--${size}${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && menuRef.current?.contains(next)) return;
          if (open) close();
        }}
      >
        <span className={`dropdown__value${selected ? "" : " is-placeholder"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <Icon name="chevron-down" className="dropdown__chevron" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              role="listbox"
              aria-labelledby={aria["aria-labelledby"]}
              aria-label={aria["aria-labelledby"] ? undefined : aria["aria-label"]}
              tabIndex={-1}
              {...{ [MENU_ATTR]: "" }}
              className={`dropdown-menu dropdown-menu--${size}${menuClassName ? ` ${menuClassName}` : ""}`}
              style={{
                ...(style ?? { top: -9999, left: -9999 }),
                visibility: style ? "visible" : "hidden",
              }}
              onMouseDown={(e) => {
                // Keep focus (and keyboard handling) on the trigger.
                e.preventDefault();
              }}
            >
              {(() => {
                let cursor = 0;
                return resolvedGroups.map((g, gi) => {
                  const headerId = g.label ? `${baseId}-grp-${gi}` : undefined;
                  const rows = g.options.map((option) => {
                    const index = cursor;
                    cursor += 1;
                    const isSelected = index === selectedIndex;
                    return (
                      <div
                        key={`${gi}:${option.value}`}
                        id={`${baseId}-opt-${index}`}
                        role="option"
                        data-index={index}
                        aria-selected={isSelected}
                        aria-disabled={option.disabled || undefined}
                        title={option.title}
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
                        <span className="dropdown-menu__label">{option.label}</span>
                        {option.hint ? <span className="dropdown-menu__hint">{option.hint}</span> : null}
                      </div>
                    );
                  });
                  return g.label ? (
                    <div key={`g${gi}`} role="group" aria-labelledby={headerId} className="dropdown-menu__group">
                      <div id={headerId} className="dropdown-menu__group-label" role="presentation">
                        {g.label}
                      </div>
                      {rows}
                    </div>
                  ) : (
                    <div key={`g${gi}`} role="presentation" className="dropdown-menu__group">
                      {rows}
                    </div>
                  );
                });
              })()}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
