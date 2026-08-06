import { describe, expect, it } from "vitest";
import {
  basenameOf,
  parentDirOf,
  splitExt,
  uniqueCopyName,
} from "./workspaceStore";

describe("basenameOf", () => {
  it("returns the last segment on posix paths", () => {
    expect(basenameOf("/home/tester/repo/a.txt")).toBe("a.txt");
    expect(basenameOf("/home/tester")).toBe("tester");
  });

  it("handles backslash paths", () => {
    expect(basenameOf("C:\\Users\\tester\\a.txt")).toBe("a.txt");
  });

  it("returns the whole string when there is no separator", () => {
    expect(basenameOf("file.txt")).toBe("file.txt");
  });
});

describe("parentDirOf", () => {
  it("returns the parent posix directory", () => {
    expect(parentDirOf("/home/tester/repo/a.txt")).toBe("/home/tester/repo");
    expect(parentDirOf("/home/tester/repo")).toBe("/home/tester");
  });

  it("returns root for a top-level entry", () => {
    expect(parentDirOf("/home")).toBe("/");
  });

  it("preserves backslash separators for windows-style paths", () => {
    expect(parentDirOf("C:\\Users\\tester\\a.txt")).toBe("C:\\Users\\tester");
  });

  it("returns the path unchanged when there is no separator", () => {
    expect(parentDirOf("name")).toBe("name");
  });
});

describe("splitExt", () => {
  it("splits name and extension", () => {
    expect(splitExt("foo.txt")).toEqual(["foo", ".txt"]);
    expect(splitExt("archive.tar.gz")).toEqual(["archive.tar", ".gz"]);
  });

  it("keeps dotfiles as a whole name", () => {
    expect(splitExt(".gitignore")).toEqual([".gitignore", ""]);
    expect(splitExt(".env")).toEqual([".env", ""]);
  });

  it("has no extension for extensionless names", () => {
    expect(splitExt("Makefile")).toEqual(["Makefile", ""]);
  });
});

describe("uniqueCopyName", () => {
  it("appends ' copy' before the extension", () => {
    expect(uniqueCopyName("/repo", "foo.txt")).toBe("/repo/foo copy.txt");
  });

  it("appends ' copy' to extensionless names", () => {
    expect(uniqueCopyName("/repo", "Makefile")).toBe("/repo/Makefile copy");
  });

  it("does not alter dotfiles' stem", () => {
    expect(uniqueCopyName("/repo", ".gitignore")).toBe("/repo/.gitignore copy");
  });
});
