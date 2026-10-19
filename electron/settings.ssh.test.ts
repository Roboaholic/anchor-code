import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => context.dir } }));
import { getHostProfile, loadSettings, saveSettings, upsertHostProfile } from "./settings.js";

beforeEach(async () => { context.dir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-settings-ssh-")); });
afterEach(async () => { await fs.rm(context.dir, { recursive: true, force: true }); });

describe("SSH settings", () => {
  it("keeps explicit passwords session-only and clears them when replaced", async () => {
    await upsertHostProfile({ id: "ssh-test", kind: "ssh", ssh: { host: "host", username: "user", password: "fixture-password" } });
    expect((await getHostProfile("ssh-test"))?.ssh?.password).toBe("fixture-password");
    expect(await fs.readFile(path.join(context.dir, "settings.json"), "utf8")).not.toContain("fixture-password");
    await saveSettings(await loadSettings());
    expect(await fs.readFile(path.join(context.dir, "settings.json"), "utf8")).not.toContain('"password"');
    await upsertHostProfile({ id: "ssh-test", kind: "ssh", ssh: { host: "host", username: "user" } });
    expect((await getHostProfile("ssh-test"))?.ssh?.password).toBeUndefined();
  });

  it("ignores legacy persisted passwords and removes them on next save", async () => {
    await fs.writeFile(path.join(context.dir, "settings.json"), JSON.stringify({ hostProfiles: [{ id: "old", kind: "ssh", ssh: { host: "old", username: "user", password: "old-secret" } }] }));
    const settings = await loadSettings();
    expect(settings.hostProfiles.find((p) => p.id === "old")?.ssh?.password).toBeUndefined();
    await saveSettings(settings);
    expect(await fs.readFile(path.join(context.dir, "settings.json"), "utf8")).not.toContain("old-secret");
  });

  it("persists an alias reference without resolved credentials", async () => {
    await upsertHostProfile({ id: "config-work", kind: "ssh", ssh: { configHost: "work" } });
    expect((await getHostProfile("config-work"))?.ssh).toEqual({ configHost: "work" });
  });
});
