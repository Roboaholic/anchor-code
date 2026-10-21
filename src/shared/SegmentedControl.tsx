import type { ReactNode } from "react";

export type SegmentOption<V extends string = string> = {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
};

export type SegmentedControlProps<V extends string = string> = {
  value: V;
  onChange: (value: V) => void;
  options: SegmentOption<V>[];
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
  size?: "sm" | "md";
};

/** All/Tracked-style segmented control. */
export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  size = "md",
  ...aria
}: SegmentedControlProps<V>) {
  return (
    <div
      className={`repo-seg anchor-seg${size === "sm" ? " anchor-seg--sm" : ""}${
        className ? ` ${className}` : ""
      }`}
      role="radiogroup"
      aria-label={aria["aria-label"]}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            className={`repo-seg__btn${active ? " is-active" : ""}`}
            aria-checked={active}
            aria-label={opt["aria-label"]}
            disabled={disabled || opt.disabled}
            onClick={() => {
              if (!active) onChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
