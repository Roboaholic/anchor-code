import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKGROUP_ID,
  DEFAULT_WORKGROUP_NAME,
  emptyWorkgroupsState,
  ensureDefaultGroup,
  parseWorkgroupsState,
  reassignGroupIds,
  removeWorkgroup,
  renameWorkgroupInState,
  uniqueWorkgroupName,
} from "./workgroups";

describe("workgroups", () => {
  it("always includes a visible default group", () => {
    const empty = parseWorkgroupsState(null);
    expect(empty.groups[0]).toMatchObject({
      id: DEFAULT_WORKGROUP_ID,
      name: DEFAULT_WORKGROUP_NAME,
    });
    expect(empty.activeGroupId).toBe(DEFAULT_WORKGROUP_ID);

    const restored = parseWorkgroupsState({
      groups: [{ id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" }],
      activeGroupId: "wg-1",
    });
    expect(restored.groups.map((group) => group.id)).toEqual([
      DEFAULT_WORKGROUP_ID,
      "wg-1",
    ]);
    expect(restored.activeGroupId).toBe("wg-1");
  });

  it("keeps a renamed default group", () => {
    const restored = parseWorkgroupsState({
      groups: [{ id: DEFAULT_WORKGROUP_ID, name: "Inbox", createdAt: "2026-01-01T00:00:00.000Z" }],
      activeGroupId: DEFAULT_WORKGROUP_ID,
    });
    expect(restored.groups).toHaveLength(1);
    expect(restored.groups[0]?.name).toBe("Inbox");
  });

  it("falls back to default when the active group is missing", () => {
    const restored = parseWorkgroupsState({
      groups: [],
      activeGroupId: "missing",
      sessionGroupById: { "sess-1": "gone" },
    });
    expect(restored.activeGroupId).toBe(DEFAULT_WORKGROUP_ID);
    expect(restored.sessionGroupById["sess-1"]).toBe(DEFAULT_WORKGROUP_ID);
  });

  it("does not delete the default group and reassigns live mappings", () => {
    const state = {
      groups: [
        ...emptyWorkgroupsState().groups,
        { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      activeGroupId: "wg-1",
      sessionGroupById: { "sess-1": "wg-1", "sess-2": DEFAULT_WORKGROUP_ID },
    };
    expect(removeWorkgroup(state, DEFAULT_WORKGROUP_ID)).toBe(state);

    const next = removeWorkgroup(state, "wg-1");
    expect(next.groups.map((group) => group.id)).toEqual([DEFAULT_WORKGROUP_ID]);
    expect(next.activeGroupId).toBe(DEFAULT_WORKGROUP_ID);
    expect(next.sessionGroupById).toEqual({
      "sess-1": DEFAULT_WORKGROUP_ID,
      "sess-2": DEFAULT_WORKGROUP_ID,
    });
    expect(reassignGroupIds({ t1: "wg-1", t2: DEFAULT_WORKGROUP_ID }, "wg-1", DEFAULT_WORKGROUP_ID)).toEqual({
      t1: DEFAULT_WORKGROUP_ID,
      t2: DEFAULT_WORKGROUP_ID,
    });
  });

  it("renames in place and generates unique workgroup names", () => {
    const state = emptyWorkgroupsState();
    const renamed = renameWorkgroupInState(state, DEFAULT_WORKGROUP_ID, "  Inbox  ");
    expect(renamed.groups[0]?.name).toBe("Inbox");
    expect(uniqueWorkgroupName(renamed.groups)).toBe("Workgroup");
    expect(
      uniqueWorkgroupName([
        { name: "Workgroup" },
        { name: "Workgroup 2" },
      ]),
    ).toBe("Workgroup 3");
  });

  it("keeps default first when ensuring groups", () => {
    const groups = ensureDefaultGroup([
      { id: "wg-1", name: "Login", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: DEFAULT_WORKGROUP_ID, name: "Inbox", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "wg-1", name: "Dup", createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(groups.map((group) => group.id)).toEqual([DEFAULT_WORKGROUP_ID, "wg-1"]);
    expect(groups[0]?.name).toBe("Inbox");
  });
});
