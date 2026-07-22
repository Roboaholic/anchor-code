import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  ensureSpawnHelperExecutable,
  TerminalService,
} from "./terminalService.js";

describe("ensureSpawnHelperExecutable", () => {
  it("makes node-pty spawn-helper executable when present", () => {
    ensureSpawnHelperExecutable();
    // Permission bits are a Unix concern; Windows has no +x equivalent.
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }
    const helper = path.join(
      process.cwd(),
      "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    );
    if (!fs.existsSync(helper)) {
      expect(true).toBe(true);
      return;
    }
    const mode = fs.statSync(helper).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("TerminalService.create (integration)", () => {
  const host = new LocalHostSession("term-test");
  const service = new TerminalService(() => null, () => host);
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
      // Integration: real PTY; wait for first data after write (no fixed sleep race).
      // TerminalService does not expose onData here — just ensure write does not throw.
      expect(() => service.write(tab.id, "echo anchor-pty-ok\r")).not.toThrow();
      expect(() => service.resize(tab.id, 100, 30)).not.toThrow();
    },
    15_000,
  );
});
