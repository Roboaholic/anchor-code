import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatPathWithLine,
  repoFileWorkspaceRelativePath,
  workspaceRelativePath,
} from "./copyPath";

describe("workspaceRelativePath", () => {
  it("strips the workspace root", () => {
    expect(
      workspaceRelativePath("/home/u/ws", "/home/u/ws/src/a.ts"),
    ).toBe("src/a.ts");
  });

  it("normalizes backslashes", () => {
    expect(
      workspaceRelativePath("C:\\ws", "C:\\ws\\src\\a.ts"),
    ).toBe("src/a.ts");
  });

  it("returns the path when there is no workspace", () => {
    expect(workspaceRelativePath(null, "/home/u/ws/src/a.ts")).toBe(
      "/home/u/ws/src/a.ts",
    );
  });
});

describe("repoFileWorkspaceRelativePath", () => {
  it("joins a nested repo file onto the workspace", () => {
    expect(
      repoFileWorkspaceRelativePath(
        "/home/miles/pyoneer_merge_back",
        "/home/miles/pyoneer_merge_back/common/camera/cam_com",
        "filter/fan_bypass/unit_test/a.c",
      ),
    ).toBe("common/camera/cam_com/filter/fan_bypass/unit_test/a.c");
  });

  it("keeps a repo-relative path when workspace is missing", () => {
    expect(
      repoFileWorkspaceRelativePath(
        null,
        "/home/u/repo",
        "filter/CMakeLists.txt",
      ),
    ).toBe("/home/u/repo/filter/CMakeLists.txt");
  });
});

describe("formatPathWithLine", () => {
  it("uses a single line for a caret", () => {
    expect(formatPathWithLine("src/a.ts", 12, 12)).toBe("src/a.ts:12");
    expect(formatPathWithLine("src/a.ts", 12)).toBe("src/a.ts:12");
  });

  it("uses a range for a multi-line selection", () => {
    expect(formatPathWithLine("src/a.ts", 12, 18)).toBe("src/a.ts:12-18");
  });

  it("orders a backwards selection", () => {
    expect(formatPathWithLine("src/a.ts", 18, 12)).toBe("src/a.ts:12-18");
  });
});

describe("diff workbench copy-path wiring", () => {
  it("registers Monaco copy actions on both diff editors", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/features/document/DiffViewer.tsx"),
      "utf8",
    );
    expect(src).toContain("registerCopyPathActions(original");
    expect(src).toContain("registerCopyPathActions(modified");
    expect(src).toContain("Copy Relative Path");
    expect(src).toContain("anchor-diff-original");
    expect(src).toContain("anchor-diff-modified");
  });
});
