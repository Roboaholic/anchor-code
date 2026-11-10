import { describe, expect, it } from "vitest";
import {
  basename,
  isMarkdownPath,
  joinPath,
  languageFromPath,
  ancestorDirKeys,
  isPathInsideRoot,
  pathsEqual,
  relativeToRoot,
  shouldHideTreeEntry,
  shouldSkipExpand,
  workspaceDisplayName,
} from "./paths";

describe("tree filters", () => {
  it("hides .DS_Store and node_modules dirs", () => {
    expect(shouldHideTreeEntry(".DS_Store", "file")).toBe(true);
    expect(shouldHideTreeEntry("node_modules", "dir")).toBe(true);
    expect(shouldHideTreeEntry("src", "dir")).toBe(false);
    expect(shouldHideTreeEntry(".git", "dir")).toBe(false); // listed, not expanded
  });

  it("skips expanding node_modules and .git", () => {
    expect(shouldSkipExpand("node_modules")).toBe(true);
    expect(shouldSkipExpand(".git")).toBe(true);
    expect(shouldSkipExpand("src")).toBe(false);
  });
});

describe("path helpers", () => {
  it("basename works for posix and windows-style", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(basename("C:\\a\\b\\c.ts")).toBe("c.ts");
  });

  it("joinPath picks separator from parent", () => {
    expect(joinPath("/home/u/proj", "src")).toBe("/home/u/proj/src");
    expect(joinPath("C:\\proj", "src")).toBe("C:\\proj\\src");
  });

  it("relativeToRoot strips prefix", () => {
    expect(relativeToRoot("/home/u/proj", "/home/u/proj/src/a.ts")).toBe(
      "src/a.ts",
    );
    expect(relativeToRoot("/home/u/proj", "/home/u/proj")).toBe("");
    expect(relativeToRoot("/home/u/proj", "/other")).toBe("/other");
  });

  it("workspaceDisplayName uses last segment", () => {
    expect(workspaceDisplayName("/Users/cm/anchor-code")).toBe("anchor-code");
  });
});

describe("language and markdown detection", () => {
  it("maps common extensions", () => {
    expect(languageFromPath("a.ts")).toBe("typescript");
    expect(languageFromPath("a.tsx")).toBe("typescript");
    expect(languageFromPath("a.js")).toBe("javascript");
    expect(languageFromPath("a.md")).toBe("markdown");
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("unknown.xyz")).toBe("plaintext");
  });

  it("detects markdown paths", () => {
    expect(isMarkdownPath("docs/a.md")).toBe(true);
    expect(isMarkdownPath("x.mdx")).toBe(true);
    expect(isMarkdownPath("a.markdown")).toBe(true);
    expect(isMarkdownPath("a.ts")).toBe(false);
  });
});

describe("pathsEqual / isPathInsideRoot / ancestorDirKeys", () => {
  it("treats slash and backslash as the same separators", () => {
    expect(pathsEqual("C:\\proj\\src\\a.ts", "C:/proj/src/a.ts")).toBe(true);
    expect(pathsEqual("/proj/src/a.ts", "/proj/src/b.ts")).toBe(false);
  });

  it("detects paths inside a workspace root across separators", () => {
    expect(isPathInsideRoot("C:\\proj", "C:/proj/src/a.ts")).toBe(true);
    expect(isPathInsideRoot("/proj", "/proj")).toBe(true);
    expect(isPathInsideRoot("/proj", "/proj-other/a.ts")).toBe(false);
    expect(isPathInsideRoot("/proj", "/other/a.ts")).toBe(false);
  });

  it("lists parent directories from the root down, excluding the file", () => {
    expect(ancestorDirKeys("/ws", "/ws/a.ts")).toEqual([]);
    expect(ancestorDirKeys("/ws", "/ws/src/lib/a.ts")).toEqual(["/ws/src", "/ws/src/lib"]);
    expect(ancestorDirKeys("C:\\ws", "C:/ws/src/a.ts")).toEqual(["C:/ws/src"]);
    expect(ancestorDirKeys("/ws", "/other/src/a.ts")).toEqual([]);
  });
});

