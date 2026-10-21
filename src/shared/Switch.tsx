import type { KeyboardEvent } from "react";

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
  className?: string;
};

/** Accessible on/off switch (role=switch). */
export function Switch({
  checked,
  onChange,
  disabled,
  id,
  className,
  ...aria
}: SwitchProps) {
  const toggle = () => {
    if (disabled) return;
    onChange(!checked);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className={`anchor-switch${checked ? " is-on" : ""}${
        disabled ? " is-disabled" : ""
      }${className ? ` ${className}` : ""}`}
      aria-checked={checked}
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      data-testid={aria["data-testid"]}
      disabled={disabled}
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      <span className="anchor-switch__thumb" aria-hidden />
    </button>
  );
}
