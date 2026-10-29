import { describe, expect, it } from "vitest";
import {
  isAgentTaskSubmitKey,
  shouldDeferAgentCtrlKey,
  shouldForceAgentSelection,
  shouldForwardAgentImagePaste,
  terminalClipboardAction,
  terminalKeySequence,
} from "./xtermSessionPool";

describe("terminalKeySequence", () => {
  it("forwards plain Tab to the shell", () => {
    expect(
      terminalKeySequence({
        key: "Tab",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("\t");
  });

  it("keeps modified Enter behavior", () => {
    expect(
      terminalKeySequence({
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe("\x1b\r");
  });
});

describe("shouldDeferAgentCtrlKey", () => {
  it("copies selected text before deferring Ctrl keys to the agent CLI", () => {
    const ctrl = { key: "c", ctrlKey: true, metaKey: false };
    expect(shouldDeferAgentCtrlKey("agent", ctrl, true)).toBe(false);
    expect(shouldDeferAgentCtrlKey("agent", ctrl, false)).toBe(true);
    expect(
      shouldDeferAgentCtrlKey(
        "agent",
        { key: "r", ctrlKey: true, metaKey: false },
        true,
      ),
    ).toBe(true);
    expect(
      shouldDeferAgentCtrlKey(
        "agent",
        { key: "v", ctrlKey: true, metaKey: false },
        false,
      ),
    ).toBe(false);
    expect(shouldDeferAgentCtrlKey("shell", ctrl, false)).toBe(false);
  });
});

describe("terminalClipboardAction", () => {
  const event = (key: string, overrides: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });

  it("copies a selected terminal range with Ctrl+C", () => {
    expect(terminalClipboardAction(event("c", { ctrlKey: true }), true)).toBe("copy");
    expect(terminalClipboardAction(event("c", { ctrlKey: true }), false)).toBeNull();
  });

  it("handles explicit paste shortcuts", () => {
    expect(terminalClipboardAction(event("v", { ctrlKey: true }), false)).toBe("paste");
    expect(terminalClipboardAction(event("Insert", { shiftKey: true }), false)).toBe("paste");
  });
});

describe("shouldForwardAgentImagePaste", () => {
  it("forwards image paste only to agent sessions", () => {
    expect(shouldForwardAgentImagePaste("agent", "paste", true)).toBe(true);
    expect(shouldForwardAgentImagePaste("shell", "paste", true)).toBe(false);
    expect(shouldForwardAgentImagePaste("agent", "paste", false)).toBe(false);
    expect(shouldForwardAgentImagePaste("agent", "copy", true)).toBe(false);
  });
});

describe("isAgentTaskSubmitKey", () => {
  it("starts work only for an unmodified Enter keydown", () => {
    expect(
      isAgentTaskSubmitKey({
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isAgentTaskSubmitKey({
        key: "a",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });
});

describe("agent terminal copy", () => {
  const ctrl = (key: string, shiftKey = false) => ({ key, ctrlKey: true, metaKey: false, shiftKey });

  it("keeps copy shortcuts in the app instead of sending them to the CLI", () => {
    expect(shouldDeferAgentCtrlKey("agent", ctrl("c"), true)).toBe(false);
    expect(shouldDeferAgentCtrlKey("agent", ctrl("C", true), false)).toBe(false);
    expect(shouldDeferAgentCtrlKey("agent", ctrl("Insert"), true)).toBe(false);
    // Unselected Ctrl+C still interrupts the agent.
    expect(shouldDeferAgentCtrlKey("agent", ctrl("c"), false)).toBe(true);
  });

  it("copies with Ctrl+Insert when text is selected", () => {
    expect(terminalClipboardAction(ctrl("Insert"), true)).toBe("copy");
    expect(terminalClipboardAction(ctrl("C", true), false)).toBe("copy");
  });

  it("forces drag selection while an agent TUI has mouse tracking on", () => {
    const down = { button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    expect(shouldForceAgentSelection("agent", "any", down)).toBe(true);
    expect(shouldForceAgentSelection("agent", "none", down)).toBe(false);
    expect(shouldForceAgentSelection("shell", "any", down)).toBe(false);
    expect(shouldForceAgentSelection("agent", "any", { ...down, button: 2 })).toBe(false);
    expect(shouldForceAgentSelection("agent", "any", { ...down, shiftKey: true })).toBe(false);
  });
});
