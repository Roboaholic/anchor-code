import { describe, expect, it } from "vitest";
import { isBinaryFile, looksBinaryContent } from "./binaryFile";

describe("binaryFile", () => {
  it("detects extensions and NUL content", () => {
    expect(isBinaryFile("build/icon.icns")).toBe(true);
    expect(isBinaryFile("readme.md")).toBe(false);
    expect(looksBinaryContent("hello\u0000world")).toBe(true);
    expect(looksBinaryContent("plain text\n")).toBe(false);
  });
});
