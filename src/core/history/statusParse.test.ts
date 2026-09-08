import { describe, expect, it } from "vitest";
import {
  isUntrackedDirectoryPath,
  mergeBadgePorcelain,
  mergeUntrackedFilePaths,
  parseBranchHeader,
  parseLsFilesOthers,
  parsePorcelainStatus,
  parsePorcelainStatusDetailed,
  statusCounts,
} from "./statusParse";

describe("parsePorcelainStatus", () => {
  it("parses modified, added, deleted, untracked", () => {
    const raw = [
      " M src/a.ts",
      "M  src/b.ts",
      "A  src/new.ts",
      " D gone.ts",
      "?? notes.tmp",
      "!! ignored.bin",
    ].join("\n");
    const entries = parsePorcelainStatus(raw);
    expect(entries.map((e) => [e.status, e.path])).toEqual([
      ["D", "gone.ts"],
      ["?", "notes.tmp"],
      ["M", "src/a.ts"],
      ["M", "src/b.ts"],
      ["A", "src/new.ts"],
    ]);
  });

  it("uses new path for renames", () => {
    const entries = parsePorcelainStatus("R  old.ts -> new.ts\n");
    expect(entries).toEqual([
      { path: "new.ts", status: "R", code: "R " },
    ]);
  });

  it("counts buckets", () => {
    const c = statusCounts(
      parsePorcelainStatus(" M a\n?? b\n D c\nA  d\n"),
    );
    expect(c).toEqual({
      modified: 1,
      added: 1,
      deleted: 1,
      untracked: 1,
      other: 0,
    });
  });

  it("parses -b branch header for ahead/behind", () => {
    const raw = [
      "## feature...origin/feature [ahead 3, behind 1]",
      " M src/a.ts",
    ].join("\n");
    const { entries, tracking } = parsePorcelainStatusDetailed(raw);
    expect(entries).toHaveLength(1);
    expect(tracking).toEqual({
      ahead: 3,
      behind: 1,
      branch: "feature",
    });
  });
});

describe("parseBranchHeader", () => {
  it("reads ahead only as ahead N behind 0", () => {
    expect(parseBranchHeader("main...origin/main [ahead 2]")).toEqual({
      ahead: 2,
      behind: 0,
      branch: "main",
    });
  });

  it("treats synced upstream as 0/0", () => {
    expect(parseBranchHeader("main...origin/main")).toEqual({
      ahead: 0,
      behind: 0,
      branch: "main",
    });
  });

  it("returns null tracking without upstream", () => {
    expect(parseBranchHeader("main")).toEqual({
      ahead: null,
      behind: null,
      branch: "main",
    });
  });
});

describe("untracked directory paths", () => {
  it("treats porcelain collapsed dirs as directory entries", () => {
    expect(isUntrackedDirectoryPath("filter/fan_bypass/unit_test/")).toBe(true);
    expect(isUntrackedDirectoryPath("filter/fan_bypass/unit_test/a.c")).toBe(
      false,
    );
  });

  it("expands a collapsed directory using ls-files output", () => {
    const porcelain = parsePorcelainStatus(
      [
        " M filter/CMakeLists.txt",
        "?? filter/fan_bypass/unit_test/",
      ].join("\n"),
    );
    const extra = parseLsFilesOthers(
      [
        "filter/fan_bypass/unit_test/a.c",
        "filter/fan_bypass/unit_test/b.c",
      ].join("\n"),
    );
    const merged = mergeUntrackedFilePaths(porcelain, extra);
    expect(merged.map((e) => [e.status, e.path])).toEqual([
      ["M", "filter/CMakeLists.txt"],
      ["?", "filter/fan_bypass/unit_test/a.c"],
      ["?", "filter/fan_bypass/unit_test/b.c"],
    ]);
  });

  it("keeps a collapsed directory when ls-files finds nothing", () => {
    const porcelain = parsePorcelainStatus("?? empty_dir/\n");
    expect(mergeUntrackedFilePaths(porcelain, [])).toEqual([
      { path: "empty_dir/", status: "?", code: "??" },
    ]);
  });
});

describe("mergeBadgePorcelain", () => {
  it("keeps untracked files when badge-only omits them", () => {
    const prev = {
      entries: [
        { path: "a.ts", status: "M", code: " M" },
        { path: "filter/fan_bypass/unit_test/a.c", status: "?", code: "??" },
        { path: "filter/fan_bypass/unit_test/b.c", status: "?", code: "??" },
      ],
      untracked: 2,
    };
    const next = {
      entries: [{ path: "a.ts", status: "M", code: " M" }],
      untracked: 0,
    };
    const merged = mergeBadgePorcelain(prev, next);
    expect(merged.entries.map((e) => e.path)).toEqual([
      "a.ts",
      "filter/fan_bypass/unit_test/a.c",
      "filter/fan_bypass/unit_test/b.c",
    ]);
    expect(merged.untracked).toBe(2);
  });

  it("drops untracked files that are now tracked", () => {
    const prev = {
      entries: [{ path: "new.ts", status: "?", code: "??" }],
      untracked: 1,
    };
    const next = {
      entries: [{ path: "new.ts", status: "A", code: "A " }],
      untracked: 0,
    };
    const merged = mergeBadgePorcelain(prev, next);
    expect(merged.entries).toEqual([
      { path: "new.ts", status: "A", code: "A " },
    ]);
    expect(merged.untracked).toBe(0);
  });

  it("does not replace a file list with a collapsed untracked directory", () => {
    const prev = {
      entries: [
        { path: "filter/fan_bypass/unit_test/a.c", status: "?", code: "??" },
        { path: "filter/fan_bypass/unit_test/b.c", status: "?", code: "??" },
      ],
      untracked: 2,
    };
    const next = {
      entries: [
        { path: "filter/fan_bypass/unit_test/", status: "?", code: "??" },
      ],
      untracked: 1,
    };
    const merged = mergeBadgePorcelain(prev, next);
    expect(merged.entries.map((e) => e.path)).toEqual([
      "filter/fan_bypass/unit_test/a.c",
      "filter/fan_bypass/unit_test/b.c",
    ]);
    expect(merged.untracked).toBe(2);
  });
});
