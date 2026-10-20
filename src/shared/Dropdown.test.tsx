// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dropdown,
  dropdownMenuPosition,
  isDropdownOpen,
  isInsideDropdownMenu,
  nextEnabledIndex,
  type DropdownGroup,
  type DropdownOption,
} from "./Dropdown";

const EFFORTS: DropdownOption[] = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh", disabled: true },
  { value: "max", label: "max" },
];

function Harness(props: {
  initial?: string;
  options?: DropdownOption[];
  groups?: DropdownGroup[];
  onChange?: (v: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(props.initial ?? "medium");
  return (
    <div>
      <Dropdown
        aria-label="Effort"
        value={value}
        options={props.options ?? EFFORTS}
        groups={props.groups}
        disabled={props.disabled}
        onChange={(v) => {
          setValue(v);
          props.onChange?.(v);
        }}
      />
      <button type="button">outside</button>
    </div>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Effort" });
const activeOption = () => {
  const id = trigger().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

describe("Dropdown", () => {
  afterEach(() => cleanup());

  it("renders the selected label and opens a listbox on click", () => {
    render(<Harness />);
    expect(trigger().textContent).toContain("medium");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox");
    expect(trigger().getAttribute("aria-controls")).toBe(list.id);
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByRole("option", { name: "medium" }).getAttribute("aria-selected")).toBe("true");
    expect(isDropdownOpen()).toBe(true);
    expect(isInsideDropdownMenu(screen.getByRole("option", { name: "low" }))).toBe(true);
    fireEvent.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(isDropdownOpen()).toBe(false);
  });

  it("selects an option by click and closes", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "high" }));
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().textContent).toContain("high");
  });

  it("ignores clicks on disabled options", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    const disabled = screen.getByRole("option", { name: "xhigh" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("supports keyboard navigation, skipping disabled options", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(activeOption()?.textContent).toContain("medium");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(activeOption()?.textContent).toContain("high");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(activeOption()?.textContent).toContain("max");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(activeOption()?.textContent).toContain("max");
    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(activeOption()?.textContent).toContain("low");
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(activeOption()?.textContent).toContain("max");
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(activeOption()?.textContent).toContain("high");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("high");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes without changing the value and does not bubble", () => {
    const onChange = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness onChange={onChange} />
      </div>,
    );
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger().textContent).toContain("medium");
    expect(outer).not.toHaveBeenCalled();
    // Closed: Escape is left to the surrounding dialog.
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("closes on outside mousedown", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByRole("option", { name: "low" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("type-ahead moves to the matching option", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "m" });
    expect(activeOption()?.textContent).toContain("max");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(trigger().textContent).toContain("max");
  });

  it("renders group headers and keeps them out of the option list", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial="new:codex"
        onChange={onChange}
        groups={[
          { label: "Sessions in this group", options: [{ value: "t1", label: "Session 1 · idle" }] },
          {
            label: "New session",
            options: [
              { value: "new:claude", label: "+ New Claude Code" },
              { value: "new:codex", label: "+ New Codex" },
            ],
          },
        ]}
      />,
    );
    expect(trigger().textContent).toContain("+ New Codex");
    fireEvent.click(trigger());
    expect(screen.getAllByRole("group")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "New session" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.keyDown(trigger(), { key: "Home" });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("t1");
  });

  it("does not open when disabled or empty", () => {
    render(<Harness disabled />);
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
    cleanup();
    render(<Harness options={[]} initial="" />);
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes when the trigger loses focus to something else", () => {
    render(<Harness />);
    fireEvent.click(trigger());
    act(() => {
      fireEvent.blur(trigger(), { relatedTarget: screen.getByRole("button", { name: "outside" }) });
    });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("dropdown helpers", () => {
  it("nextEnabledIndex skips disabled and stops at the ends", () => {
    const opts = [{}, { disabled: true }, {}, {}];
    expect(nextEnabledIndex(opts, 0, 1)).toBe(2);
    expect(nextEnabledIndex(opts, 2, -1)).toBe(0);
    expect(nextEnabledIndex(opts, 3, 1)).toBe(3);
    expect(nextEnabledIndex(opts, 0, -1)).toBe(0);
    expect(nextEnabledIndex(opts, -1, 1, 10)).toBe(3);
  });

  it("places the menu below, flips above near the bottom, and clamps to the viewport", () => {
    const vp = { width: 800, height: 600 };
    const below = dropdownMenuPosition({ top: 100, bottom: 130, left: 50, width: 200 }, { width: 200, height: 150 }, vp);
    expect(below.placement).toBe("below");
    expect(below.top).toBe(134);
    const above = dropdownMenuPosition({ top: 520, bottom: 550, left: 50, width: 200 }, { width: 200, height: 150 }, vp);
    expect(above.placement).toBe("above");
    expect(above.top).toBe(520 - 4 - 150);
    const clamped = dropdownMenuPosition({ top: 100, bottom: 130, left: 700, width: 90 }, { width: 240, height: 100 }, vp);
    expect(clamped.left).toBe(800 - 8 - 240);
    const tall = dropdownMenuPosition({ top: 100, bottom: 130, left: 0, width: 90 }, { width: 100, height: 2000 }, vp);
    expect(tall.maxHeight).toBeLessThanOrEqual(300);
    expect(tall.left).toBe(8);
  });
});
