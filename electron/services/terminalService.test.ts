import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSpawnHelperExecutable,
  TerminalService,
} from "./terminalService.js";

describe("ensureSpawnHelperExecutable", () => {
  it("makes node-pty spawn-helper executable when present", () => {
    ensureSpawnHelperExecutable();
    const helper = path.join(
      process.cwd(),
      "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    );
    if (!fs.existsSync(helper)) {
      // Other platforms / missing prebuild — skip soft assert
      expect(true).toBe(true);
      return;
    }
    const mode = fs.statSync(helper).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("TerminalService.create (integration)", () => {
  const service = new TerminalService(() => null);
  const tabs: string[] = [];

  afterEach(() => {
    for (const id of tabs) service.kill(id);
    tabs.length = 0;
    service.disposeAll();
  });

  it(
    "spawns a local shell without posix_spawnp error",
    async () => {
      const cwd = os.tmpdir();
      const tab = await service.create(cwd, 80, 24);
      tabs.push(tab.id);
      expect(tab.status).toBe("running");
      expect(tab.cwd).toBeTruthy();
      expect(tab.id).toBeTruthy();
      // write a no-op command; should not throw
      service.write(tab.id, "echo anchor-pty-ok\r");
      await new Promise((r) => setTimeout(r, 200));
    },
    15_000,
  );
});
