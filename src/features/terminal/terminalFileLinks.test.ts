import { describe, expect, it } from "vitest";
import {
  findTerminalFileLinks,
  resolveTerminalFilePath,
} from "./terminalFileLinks";

describe("findTerminalFileLinks", () => {
  it("extracts relative paths with line and column", () => {
    expect(findTerminalFileLinks("error at src/main.tsx:42:7")).toEqual([
      expect.objectContaining({
        text: "src/main.tsx:42:7",
        path: "src/main.tsx",
        line: 42,
        column: 7,
      }),
    ]);
  });

  it("extracts Windows and POSIX absolute paths", () => {
    const links = findTerminalFileLinks(
      "C:\\repo\\src\\main.ts:9 /home/me/repo/app.ts#L12C3",
    );
    expect(links.map(({ path, line, column }) => ({ path, line, column }))).toEqual([
      { path: "C:\\repo\\src\\main.ts", line: 9, column: undefined },
      { path: "/home/me/repo/app.ts", line: 12, column: 3 },
    ]);
  });

  it("strips surrounding output punctuation and ignores URLs", () => {
    expect(findTerminalFileLinks("(src/a.ts:3), https://host/src/a.ts:4")).toEqual([
      expect.objectContaining({ text: "src/a.ts:3", path: "src/a.ts", line: 3 }),
    ]);
  });
});

describe("resolveTerminalFilePath", () => {
  it("resolves relative paths using the workspace separator", () => {
    expect(resolveTerminalFilePath("/repo", "./src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolveTerminalFilePath("C:\\repo", "src/a.ts")).toBe(
      "C:\\repo\\src/a.ts",
    );
  });

  it("keeps absolute paths", () => {
    expect(resolveTerminalFilePath("/repo", "/tmp/a.ts")).toBe("/tmp/a.ts");
    expect(resolveTerminalFilePath("C:\\repo", "D:\\tmp\\a.ts")).toBe(
      "D:\\tmp\\a.ts",
    );
  });
});
