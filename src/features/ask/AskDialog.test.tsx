// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { AskDialog } from "./AskDialog";
import { openAsk, useAskStore } from "./askStore";

const ctx = {
  path: "/repo/electron/services/contentSearch.ts",
  startLine: 9,
  endLine: 15,
  snippet: "export interface X {}",
  anchor: { top: 100, bottom: 118, left: 40 },
};

describe("AskDialog popover", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabs: [],
      agentProfiles: [{ id: "claude", name: "Claude", enabled: true }] as never,
      defaultAgentId: "claude",
      loadAgentProfiles: async () => {},
    } as never);
    useAskStore.setState({ context: null, drafts: {} });
  });
  afterEach(() => {
    cleanup();
    useAskStore.setState({ context: null, drafts: {} });
  });

  it("opens with no sessions and survives editor scroll events", () => {
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    render(<AskDialog />);
    act(() => openAsk(ctx));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("contentSearch.ts")).toBeTruthy();
    expect(screen.getByText("L9-15")).toBeTruthy();
    const picker = screen.getByRole("combobox", { name: "Agent session" });
    expect(picker.textContent).toContain("+ New Claude");
    // Monaco emits scroll events on its own nodes while re-rendering.
    act(() => {
      outside.dispatchEvent(new Event("scroll"));
    });
    expect(useAskStore.getState().context).not.toBeNull();
    outside.remove();
  });

  it("session picker is a themed listbox with group headers; using it keeps the popover open", () => {
    useTerminalStore.setState({
      agentProfiles: [
        { id: "claude", name: "Claude", enabled: true },
        { id: "pi", name: "Pi", enabled: true },
      ] as never,
    } as never);
    render(<AskDialog />);
    act(() => openAsk(ctx));
    const picker = screen.getByRole("combobox", { name: "Agent session" });
    fireEvent.click(picker);
    expect(screen.getByRole("group", { name: "New session" })).toBeTruthy();
    const pi = screen.getByRole("option", { name: "+ New Pi" });
    fireEvent.mouseDown(pi);
    fireEvent.wheel(pi);
    expect(useAskStore.getState().context).not.toBeNull();
    fireEvent.click(pi);
    expect(picker.textContent).toContain("+ New Pi");
    // Esc closes the menu first, then the popover.
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(useAskStore.getState().context).not.toBeNull();
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(useAskStore.getState().context).toBeNull();
  });

  it("closes on outside mousedown and keeps the draft", () => {
    render(<AskDialog />);
    act(() => openAsk(ctx));
    fireEvent.change(screen.getByLabelText("Question about the selection"), {
      target: { value: "why?" },
    });
    fireEvent.mouseDown(document.body);
    expect(useAskStore.getState().context).toBeNull();
    act(() => openAsk(ctx));
    expect(
      (screen.getByLabelText("Question about the selection") as HTMLTextAreaElement).value,
    ).toBe("why?");
  });

  it("keeps focus and the full text while typing", async () => {
    render(<AskDialog />);
    act(() => openAsk(ctx));
    const box = screen.getByLabelText("Question about the selection") as HTMLTextAreaElement;
    box.focus();
    await userEvent.type(box, "What does this function do?");
    await new Promise((r) => setTimeout(r, 50));
    expect(box.value).toBe("What does this function do?");
    expect(document.activeElement).toBe(box);
    expect(useAskStore.getState().drafts["/repo/electron/services/contentSearch.ts#9-15"]).toBe(
      "What does this function do?",
    );
  });
});
