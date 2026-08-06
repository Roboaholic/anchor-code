import { describe, expect, it } from "vitest";
import {
  isAgentTaskSubmitKey,
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
