import { describe, expect, it } from "vitest";
import {
  makeCompareEntry,
  pushRecentCompare,
  removeRecentCompare,
} from "./recentCompare";

describe("pushRecentCompare", () => {
  it("prepends and dedupes by id", () => {
    const a = makeCompareEntry({
      repoRoot: "/r",
      repoName: "r",
      base: "aaa",
      head: "bbb",
      label: "aaa → bbb",
      createdAt: "2020-01-01",
    });
    const b = makeCompareEntry({
      repoRoot: "/r",
      repoName: "r",
      base: "ccc",
      head: "worktree",
      label: "ccc → worktree",
      createdAt: "2020-01-02",
    });
    const a2 = makeCompareEntry({
      repoRoot: "/r",
      repoName: "r",
      base: "aaa",
      head: "bbb",
      label: "aaa → bbb",
      createdAt: "2020-01-03",
    });
    let list = pushRecentCompare([], a);
    list = pushRecentCompare(list, b);
    list = pushRecentCompare(list, a2);
    expect(list.map((e) => e.id)).toEqual([a2.id, b.id]);
    expect(list[0]!.createdAt).toBe("2020-01-03");
  });

  it("caps length", () => {
    let list = [] as ReturnType<typeof makeCompareEntry>[];
    for (let i = 0; i < 20; i++) {
      list = pushRecentCompare(
        list,
        makeCompareEntry({
          repoRoot: "/r",
          repoName: "r",
          base: `b${i}`,
          head: "worktree",
          label: `${i}`,
        }),
        5,
      );
    }
    expect(list.length).toBe(5);
    expect(list[0]!.base).toBe("b19");
  });
});

describe("removeRecentCompare", () => {
  it("drops by id", () => {
    const e = makeCompareEntry({
      repoRoot: "/r",
      repoName: "r",
      base: "a",
      head: "b",
      label: "a → b",
    });
    expect(removeRecentCompare([e], e.id)).toEqual([]);
  });
});
