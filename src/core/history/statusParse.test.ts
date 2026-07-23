import { describe, expect, it } from "vitest";
import { parsePorcelainStatus, statusCounts } from "./statusParse";

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
});
