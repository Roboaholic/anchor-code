import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => context.dir } }));

import {
  loadSettings,
  pushRecentWorkspace,
  removeRecentWorkspace,
} from "./settings.js";

beforeEach(async () => {
  context.dir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-settings-recent-"));
});
afterEach(async () => {
  await fs.rm(context.dir, { recursive: true, force: true });
});

describe("recent workspace persistence", () => {
  it("pushes, dedupes by path+host, and removes entries", async () => {
    await pushRecentWorkspace("/a", "local-default");
    await pushRecentWorkspace("/b", "wsl-default");
    await pushRecentWorkspace("/a", "local-default");
    let settings = await loadSettings();
    expect(settings.recentWorkspaces.map((r) => `${r.hostProfileId}:${r.path}`)).toEqual([
      "local-default:/a",
      "wsl-default:/b",
    ]);
    expect(settings.lastHostProfileId).toBe("local-default");

    const next = await removeRecentWorkspace("/a", "local-default");
    expect(next.map((r) => r.path)).toEqual(["/b"]);
    settings = await loadSettings();
    expect(settings.recentWorkspaces.map((r) => r.path)).toEqual(["/b"]);

    const same = await removeRecentWorkspace("/missing", "local-default");
    expect(same.map((r) => r.path)).toEqual(["/b"]);
  });
});
