import type { ChangeEvent, ReactNode } from "react";

export type CheckboxProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: ReactNode;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

/** Themed checkbox with optional label. */
export function Checkbox({
  checked,
  onChange,
  disabled,
  id,
  label,
  className,
  ...aria
}: CheckboxProps) {
  const input = (
    <input
      id={id}
      type="checkbox"
      className="anchor-checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={aria["aria-label"]}
      data-testid={aria["data-testid"]}
      onChange={(e: ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.checked)
      }
    />
  );
  if (label == null) {
    return (
      <span className={`anchor-checkbox-wrap${className ? ` ${className}` : ""}`}>
        {input}
      </span>
    );
  }
  return (
    <label
      className={`anchor-checkbox-label${className ? ` ${className}` : ""}`}
    >
      {input}
      <span>{label}</span>
    </label>
  );
}
