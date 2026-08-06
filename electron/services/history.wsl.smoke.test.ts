import { afterAll, describe, expect, it } from "vitest";
import { WslHostSession } from "../host/wslHost.js";
import { discoverRepos, loadRepoStatus } from "./historyService.js";

const isWin = process.platform === "win32";
const smokeRoot = process.env.ANCHOR_WSL_SMOKE_ROOT;

describe.runIf(isWin && Boolean(smokeRoot))("WSL history + pty smoke", () => {
  let host: WslHostSession | null = null;

  afterAll(async () => {
    if (host) await host.dispose();
  });

  it(
    "discovers repos without .repo and statuses settle",
    async () => {
      host = new WslHostSession({
        profileId: "wsl-smoke",
        distro: "Ubuntu-24.04",
      });
      const t0 = Date.now();
      const repos = await discoverRepos(host, smokeRoot!);
      const discoverMs = Date.now() - t0;
      console.log(
        "discover",
        discoverMs,
        "ms",
        repos.map((r) => r.name).join(", "),
      );
      expect(discoverMs).toBeLessThan(30_000);
      expect(repos.every((r) => !r.root.includes("/.repo/"))).toBe(true);

      const t1 = Date.now();
      for (const r of repos.slice(0, 10)) {
        const s0 = Date.now();
        const st = await loadRepoStatus(host, r.root);
        console.log(
          "status",
          r.name,
          Date.now() - s0,
          "ms",
          `M${st.modified} ?${st.untracked}`,
        );
        expect(st.repoRoot).toBe(r.root);
      }
      expect(Date.now() - t1).toBeLessThan(60_000);
    },
    90_000,
  );

  it(
    "opens a WSL PTY",
    async () => {
      host =
        host ??
        new WslHostSession({
          profileId: "wsl-smoke",
          distro: "Ubuntu-24.04",
        });
      const pty = await host.openPty(smokeRoot!, 80, 24);
      expect(pty.id).toBeTruthy();
      let data = "";
      pty.onData((d) => {
        data += d;
      });
      await new Promise((r) => setTimeout(r, 1200));
      console.log("pty sample", JSON.stringify(data.slice(0, 80)));
      pty.kill();
    },
    30_000,
  );
});
