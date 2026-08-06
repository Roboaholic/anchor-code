import { describe, expect, it } from "vitest";
import { isAgentTaskSubmitKey, terminalKeySequence } from "./xtermSessionPool";

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
