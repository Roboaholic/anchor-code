import { afterEach, describe, expect, it } from "vitest";
import {
  buildWslAgentShellArgs,
  listWslDistros,
  WslHostSession,
} from "./wslHost.js";
import { HostError } from "./types.js";

const isWin = process.platform === "win32";

describe("listWslDistros", () => {
  it("returns empty list off Windows", async () => {
    if (isWin) return;
    expect(await listWslDistros()).toEqual([]);
  });

  it(
    "lists installed distros on Windows when WSL is present",
    async () => {
      if (!isWin) return;
      const distros = await listWslDistros();
      // Soft: machines without WSL still pass with [].
      expect(Array.isArray(distros)).toBe(true);
      for (const d of distros) {
        expect(d.length).toBeGreaterThan(0);
        expect(d).not.toMatch(/\u0000/);
      }
    },
    20_000,
  );
});

describe("buildWslAgentShellArgs", () => {
  it("loads interactive login setup before launching agent CLIs", () => {
    expect(
      buildWslAgentShellArgs("claude", ["--model", "sonnet"], {
        ANTHROPIC_API_KEY: "secret value",
      }),
    ).toEqual([
      "--",
      "bash",
      "-lic",
      "export ANTHROPIC_API_KEY='secret value'; exec \"$@\"",
      "anchor-agent",
      "claude",
      "--model",
      "sonnet",
    ]);
  });

  it("passes multiline prompts as literal argv data", () => {
    expect(buildWslAgentShellArgs("codex", ["修复\n$(touch pwned)"])).toEqual([
      "--",
      "bash",
      "-lic",
      "exec \"$@\"",
      "anchor-agent",
      "codex",
      "修复\n$(touch pwned)",
    ]);
  });
});

describe("WslHostSession", () => {
  let host: WslHostSession | null = null;

  afterEach(async () => {
    if (host) {
      await host.dispose();
      host = null;
    }
  });

  it("refuses construction use on non-Windows via openPty", async () => {
    if (isWin) return;
    host = new WslHostSession({ profileId: "wsl-test" });
    await expect(host.openPty("/", 80, 24)).rejects.toBeInstanceOf(HostError);
  });

  it(
    "lists home via UNC fast path when a distro is available",
    async () => {
      if (!isWin) return;
      const distros = await listWslDistros();
      if (distros.length === 0) {
        expect(true).toBe(true);
        return;
      }
      const distro = distros[0]!;
      host = new WslHostSession({
        profileId: "wsl-test",
        distro,
      });

      const homeRun = await host.run("/", "bash", [
        "-lc",
        "printf %s \"$HOME\"",
      ]);
      expect(homeRun.code).toBe(0);
      const home = homeRun.stdout.trim();
      expect(home.startsWith("/")).toBe(true);

      expect(await host.exists(home)).toBe(true);
      const st = await host.stat(home);
      expect(st.isDir).toBe(true);

      const entries = await host.listDir(home);
      expect(Array.isArray(entries)).toBe(true);
      // Home usually has at least one entry; do not hard-require if empty.
      for (const e of entries.slice(0, 5)) {
        expect(e.name).toBeTruthy();
        expect(e.type === "file" || e.type === "dir").toBe(true);
      }

      // Round-trip write under /tmp (POSIX path; UNC under the hood).
      const probe = `/tmp/anchor-wsl-host-test-${Date.now()}.txt`;
      const payload = `anchor-wsl-${Date.now()}\n`;
      await host.writeFile(probe, payload);
      expect(await host.exists(probe)).toBe(true);
      const readBack = await host.readFile(probe);
      expect(readBack).toBe(payload);
      // best-effort cleanup via wsl
      await host.run("/", "rm", ["-f", probe]);

      // Nested mkdirp must work even when UNC recursive create fails.
      const nested = `/tmp/anchor-wsl-mkdir-${Date.now()}/.agents/skills/anchor-review`;
      await host.mkdirp(nested);
      expect(await host.exists(nested)).toBe(true);
      await host.writeFile(`${nested}/SKILL.md`, "# skill\n");
      expect(await host.readFile(`${nested}/SKILL.md`)).toBe("# skill\n");
      await host.run("/", "rm", ["-rf", nested.replace(/\/\.agents.*/, "")]);
    },
    60_000,
  );

  it(
    "maps missing paths to not_found",
    async () => {
      if (!isWin) return;
      const distros = await listWslDistros();
      if (distros.length === 0) {
        expect(true).toBe(true);
        return;
      }
      host = new WslHostSession({
        profileId: "wsl-test",
        distro: distros[0],
      });
      await expect(
        host.readFile("/tmp/anchor-definitely-missing-xyz.txt"),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(await host.exists("/tmp/anchor-definitely-missing-xyz.txt")).toBe(
        false,
      );
    },
    30_000,
  );
});
