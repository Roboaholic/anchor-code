import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => context.dir } }));
import { loadSettings, saveSettings } from "./settings.js";

beforeEach(async () => { context.dir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-settings-relay-")); });
afterEach(async () => { await fs.rm(context.dir, { recursive: true, force: true }); });

describe("legacy Mobile access settings", () => {
  it("treats a stored enabled relay as disabled and persists it disabled", async () => {
    const file = path.join(context.dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({
      remoteAccess: {
        enabled: true,
        relay: { enabled: true, url: "https://relay.invalid", roomId: "room-1", hostPeerId: "pc-1", ticket: "t", secret: "s" },
      },
    }));
    const settings = await loadSettings();
    expect(settings.remoteAccess?.enabled).toBe(false);
    expect(settings.remoteAccess?.relay?.enabled).toBe(false);
    await saveSettings(settings);
    const persisted = JSON.parse(await fs.readFile(file, "utf8"));
    expect(persisted.remoteAccess.enabled).toBe(false);
    expect(persisted.remoteAccess.relay.enabled).toBe(false);
  });
});
