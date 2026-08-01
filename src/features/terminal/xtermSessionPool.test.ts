import { describe, expect, it } from "vitest";
import { terminalKeySequence } from "./xtermSessionPool";

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
