import { describe, expect, it } from "vitest";
import {
  diffLargeFiles,
  overlapWarning,
  pushExposesAnchorRefs,
  refspecCoversAnchor,
  retentionVictims,
  type SnapshotMeta,
} from "./model";

function snap(p: Partial<SnapshotMeta> & { id: string; createdAt: string }): SnapshotMeta {
  return { v: 1, workspaceRoot: "/ws", name: p.id, source: "manual", repos: [], ...p };
}

describe("push exposure", () => {
  it("detects mirror remotes and refspecs that cover refs/anchor", () => {
    expect(pushExposesAnchorRefs("remote.origin.mirror true")).toBe(true);
    expect(pushExposesAnchorRefs("remote.origin.push +refs/*:refs/*")).toBe(true);
    expect(pushExposesAnchorRefs("remote.backup.push refs/anchor/*:refs/anchor/*")).toBe(true);
    expect(pushExposesAnchorRefs("remote.origin.push refs/heads/*:refs/heads/*")).toBe(false);
    expect(pushExposesAnchorRefs("remote.origin.mirror false")).toBe(false);
    expect(pushExposesAnchorRefs("")).toBe(false);
    expect(refspecCoversAnchor(":")).toBe(false);
    expect(refspecCoversAnchor("HEAD")).toBe(false);
  });
});

describe("diffLargeFiles", () => {
  it("reports added, changed and deleted large files by size/mtime", () => {
    expect(
      diffLargeFiles(
        [
          { path: "a.bin", size: 10, mtimeMs: 1 },
          { path: "b.bin", size: 10, mtimeMs: 1 },
          { path: "c.bin", size: 10, mtimeMs: 1 },
        ],
        [
          { path: "a.bin", size: 10, mtimeMs: 1 },
          { path: "b.bin", size: 10, mtimeMs: 2 },
          { path: "d.bin", size: 7, mtimeMs: 1 },
        ],
      ),
    ).toEqual([
      { path: "b.bin", size: 10, status: "M" },
      { path: "c.bin", size: 10, status: "D" },
      { path: "d.bin", size: 7, status: "A" },
    ]);
  });
});

describe("retentionVictims", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  it("keeps manual forever and caps auto at 500 / 30 days, agent at 30 days", () => {
    const list: SnapshotMeta[] = [
      snap({ id: "m", source: "manual", createdAt: "2020-01-01T00:00:00Z" }),
      snap({ id: "ag-old", source: "agent", createdAt: "2026-09-01T00:00:00Z" }),
      snap({ id: "ag-new", source: "agent", createdAt: "2026-11-01T00:00:00Z" }),
      snap({ id: "auto-old", source: "auto", createdAt: "2026-09-01T00:00:00Z" }),
      ...Array.from({ length: 501 }, (_, i) =>
        snap({ id: `a${i}`, source: "auto", createdAt: new Date(now - (i + 1) * 1000).toISOString() }),
      ),
    ];
    const v = retentionVictims(list, now);
    expect(v).toContain("ag-old");
    expect(v).toContain("auto-old");
    expect(v).toContain("a500");
    expect(v).not.toContain("a499");
    expect(v).not.toContain("m");
    expect(v).not.toContain("ag-new");
  });
});

describe("overlapWarning", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 4, 8, m)).toISOString();
  const turn = (id: string, agent: string, m: number, phase: "start" | "end") =>
    snap({ id, source: "auto", agentTabId: agent, agentLabel: agent, turn: { index: 1, phase }, createdAt: t(m) });

  it("is silent for exactly one agent turn", () => {
    const list = [turn("s", "Codex", 0, "start"), turn("e", "Codex", 10, "end")];
    expect(overlapWarning(list, "s", "e")).toBeUndefined();
  });

  it("warns when two agents worked in the window", () => {
    const list = [
      turn("s1", "Codex", 0, "start"),
      turn("s2", "Claude", 2, "start"),
      turn("e2", "Claude", 5, "end"),
      turn("e1", "Codex", 10, "end"),
    ];
    expect(overlapWarning(list, "s1", "e1")).toMatch(/多个 agent/);
  });

  it("warns when the window only partly covers a turn", () => {
    const list = [
      snap({ id: "m", createdAt: t(3) }),
      turn("s", "Codex", 0, "start"),
      turn("e", "Codex", 10, "end"),
    ];
    expect(overlapWarning(list, "m", "e")).toMatch(/部分重叠/);
  });
});
