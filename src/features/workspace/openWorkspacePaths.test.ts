import { describe, expect, it } from "vitest";
import {
  filterBrowseDirs,
  isWindowsClient,
  joinPosix,
  parentPosix,
} from "./openWorkspacePaths";

describe("parentPosix", () => {
  it("returns null at root", () => {
    expect(parentPosix("/")).toBeNull();
    expect(parentPosix("")).toBeNull();
  });

  it("returns parent for nested paths", () => {
    expect(parentPosix("/home/miles")).toBe("/home");
    expect(parentPosix("/home/miles/repo")).toBe("/home/miles");
    expect(parentPosix("/home")).toBe("/");
  });

  it("strips trailing slashes", () => {
    expect(parentPosix("/home/miles/")).toBe("/home");
  });
});

describe("joinPosix", () => {
  it("joins under root", () => {
    expect(joinPosix("/", "home")).toBe("/home");
  });

  it("joins nested", () => {
    expect(joinPosix("/home/miles", "repo")).toBe("/home/miles/repo");
    expect(joinPosix("/home/miles/", "repo")).toBe("/home/miles/repo");
  });
});

describe("filterBrowseDirs", () => {
  it("keeps only non-dot directories sorted", () => {
    const out = filterBrowseDirs([
      { name: "zebra", type: "dir" },
      { name: "file.txt", type: "file" },
      { name: ".hidden", type: "dir" },
      { name: "alpha", type: "dir" },
      { name: "..", type: "dir" },
      { name: ".", type: "dir" },
    ]);
    expect(out.map((e) => e.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("isWindowsClient", () => {
  it("detects Windows userAgent", () => {
    expect(isWindowsClient("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      true,
    );
    expect(isWindowsClient("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(
      false,
    );
    expect(isWindowsClient("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });
});
