import { describe, expect, it } from "vitest";
import { planFileChanges } from "./fileChangeActions";

describe("filename index changes", () => {
  it("does no tree or index work for a content-only write burst", () => {
    expect(planFileChanges({ dir: "/repo", changes: Array.from({ length: 100 }, (_, i) => ({
      rel: `file${i}.ts`, path: `/repo/file${i}.ts`, eventType: "change",
    })) })).toEqual({ refreshTree: false, rebuildIndex: false, deltas: [] });
  });

  it("uses rename metadata to add/remove paths without stat IPC", () => {
    expect(planFileChanges({ dir: "/repo", changes: [
      { rel: "old-dir", path: "/repo/old-dir", eventType: "rename", kind: "missing" },
      { rel: "new.ts", path: "/repo/new.ts", eventType: "rename", kind: "file" },
    ] })).toEqual({ refreshTree: true, rebuildIndex: false, deltas: [{ rel: "old-dir", exists: false }, { rel: "new.ts", exists: true }] });
  });

  it.each(["dir", "unknown", undefined] as const)("rebuilds on %s rename metadata so subtrees/errors cannot leave an incomplete index", (kind) => {
    expect(planFileChanges({ dir: "/repo", changes: [
      { rel: "new-dir", path: "/repo/new-dir", eventType: "rename", kind },
    ] })).toEqual({ refreshTree: true, rebuildIndex: true, deltas: [] });
  });

  it.each([".anchorignore", ".gitignore"])("invalidates the file index when %s contents change", (name) => {
    expect(planFileChanges({ dir: "/repo", changes: [
      { rel: name, path: `/repo/${name}`, eventType: "change" },
    ] })).toEqual({ refreshTree: false, rebuildIndex: true, deltas: [] });
  });

  it("keeps legacy directory-only notifications functional", () => {
    expect(planFileChanges({ dir: "/repo" })).toEqual({ refreshTree: true, rebuildIndex: true, deltas: [] });
  });
});
