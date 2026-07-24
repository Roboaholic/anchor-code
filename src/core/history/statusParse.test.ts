import { describe, expect, it } from "vitest";
import {
  parseBranchHeader,
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
