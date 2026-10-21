import { describe, expect, it } from "vitest";
import { formatError } from "./formatError";

describe("formatError", () => {
  it("strips Electron remote-method prefixes and Error:", () => {
    expect(
      formatError(
        new Error(
          "Error invoking remote method 'workspace:open': Error: ENOENT: no such file",
        ),
      ),
    ).toBe("ENOENT: no such file");
    expect(formatError(new Error("Error: boom"))).toBe("boom");
  });

  it("keeps the first line only", () => {
    expect(formatError("first\nsecond\nthird")).toBe("first");
  });

  it("handles non-Error values", () => {
    expect(formatError("plain")).toBe("plain");
    expect(formatError(null)).toBe("Something went wrong");
  });
});
