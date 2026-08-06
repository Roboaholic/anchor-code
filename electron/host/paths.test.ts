import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  hostBasename,
  hostDirname,
  hostIsAbsolute,
  hostJoin,
  hostNormalize,
  isPosixHost,
} from "./paths.js";

describe("host paths", () => {
  it("treats wsl/ssh as posix", () => {
    expect(isPosixHost("wsl")).toBe(true);
    expect(isPosixHost("ssh")).toBe(true);
    expect(isPosixHost("local")).toBe(false);
  });

  it("joins and basenames posix for wsl and ssh", () => {
    for (const kind of ["wsl", "ssh"] as const) {
      expect(hostJoin(kind, "/home/u", "repo")).toBe("/home/u/repo");
      expect(hostJoin(kind, "/home/u/", "repo")).toBe("/home/u/repo");
      expect(hostBasename(kind, "/home/u/repo")).toBe("repo");
      expect(hostDirname(kind, "/home/u/repo")).toBe("/home/u");
      expect(hostDirname(kind, "/repo")).toBe("/");
      expect(hostNormalize(kind, "/home/u/../u/repo")).toBe("/home/u/repo");
      expect(hostNormalize(kind, "\\home\\u\\repo")).toBe("/home/u/repo");
      expect(hostIsAbsolute(kind, "/tmp")).toBe(true);
      expect(hostIsAbsolute(kind, "tmp")).toBe(false);
    }
  });

  it("does not windows-resolve wsl absolute paths", () => {
    const n = hostNormalize("wsl", "/home/tester/example-project");
    expect(n.startsWith("/")).toBe(true);
    expect(n).toContain("example-project");
    // Must not become a Windows drive path
    expect(/^[A-Za-z]:/.test(n)).toBe(false);
  });

  it("uses platform path semantics for local", () => {
    const joined = hostJoin("local", process.cwd(), "pkg");
    expect(joined).toBe(path.join(process.cwd(), "pkg"));
    const base = hostBasename("local", joined);
    expect(base).toBe("pkg");
    expect(hostIsAbsolute("local", process.cwd())).toBe(true);
  });

  it("normalizes root-only posix paths", () => {
    expect(hostNormalize("wsl", "/")).toBe("/");
    expect(hostNormalize("ssh", "/./")).toBe("/");
  });
});
