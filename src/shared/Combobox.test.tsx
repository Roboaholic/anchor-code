// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox, type ComboboxOption } from "./Combobox";

const HOSTS: ComboboxOption[] = [
  { value: "devsrv", label: "devsrv", hint: String.raw`C:\Users\miles\.ssh\config` },
  { value: "pyoneer3", label: "pyoneer3", hint: String.raw`C:\Users\miles\.ssh\config` },
  { value: "jump-work", label: "jump-work", hint: "~/.ssh/config" },
];

function Harness(props: {
  initial?: string;
  options?: ComboboxOption[];
  onChange?: (v: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <div>
      <label htmlFor="host">SSH config host</label>
      <Combobox
        id="host"
        value={value}
        options={props.options ?? HOSTS}
        disabled={props.disabled}
        placeholder="Select or type a host alias"
        onChange={(v) => {
          setValue(v);
          props.onChange?.(v);
        }}
      />
      <button type="button">outside</button>
    </div>
  );
}

const input = () => screen.getByLabelText("SSH config host") as HTMLInputElement;
const toggle = () => screen.getByRole("button", { name: "Show host suggestions" });

describe("Combobox", () => {
  afterEach(() => cleanup());

  it("renders a free-typing input with a themed chevron toggle", () => {
    render(<Harness />);
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(toggle()).toBeTruthy();
    expect(document.querySelector(".combobox__chevron")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens a themed listbox with host + hint rows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    const list = screen.getByRole("listbox");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-controls")).toBe(list.id);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain("devsrv");
    expect(options[0].querySelector(".dropdown-menu__hint")?.textContent).toBe(
      String.raw`C:\Users\miles\.ssh\config`,
    );
    expect(list.parentElement).toBe(document.body);
  });

  it("selects an option on click and keeps free typing", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(toggle());
    await user.click(screen.getByRole("option", { name: /pyoneer3/ }));
    expect(onChange).toHaveBeenCalledWith("pyoneer3");
    expect(input().value).toBe("pyoneer3");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.clear(input());
    await user.type(input(), "custom-host");
    expect(input().value).toBe("custom-host");
    expect(onChange).toHaveBeenCalledWith("custom-host");
  });

  it("supports keyboard navigation and Escape", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.click(input());
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("devsrv");
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(toggle());
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on outside click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(toggle());
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open when there are no options", async () => {
    const user = userEvent.setup();
    render(<Harness options={[]} />);
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    await user.click(input());
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(input(), "typed");
    expect(input().value).toBe("typed");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lets Enter submit a surrounding form when no option is highlighted", async () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    const onChange = vi.fn();
    function FormHarness() {
      const [value, setValue] = useState("work");
      return (
        <form onSubmit={onSubmit}>
          <label htmlFor="host2">SSH config host</label>
          <Combobox
            id="host2"
            value={value}
            options={[{ value: "work", label: "work", hint: "~/.ssh/config" }, ...HOSTS]}
            onChange={(v) => {
              setValue(v);
              onChange(v);
            }}
          />
          <button type="submit">Connect</button>
        </form>
      );
    }
    const user = userEvent.setup();
    render(<FormHarness />);
    await user.click(screen.getByLabelText("SSH config host"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
