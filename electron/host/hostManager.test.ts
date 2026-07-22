import { afterEach, describe, expect, it } from "vitest";
import { HostManager, createHostForProfile } from "./hostManager.js";
import { HostError } from "./types.js";
import { LocalHostSession } from "./localHost.js";
import { WslHostSession } from "./wslHost.js";
import { SshHostSession } from "./sshHost.js";

describe("createHostForProfile", () => {
  it("creates a local host with profile id", () => {
    const host = createHostForProfile({
      id: "local-default",
      kind: "local",
    });
    expect(host).toBeInstanceOf(LocalHostSession);
    expect(host.kind).toBe("local");
    expect(host.profileId).toBe("local-default");
  });

  it("creates an ssh host when config is complete", () => {
    const host = createHostForProfile({
      id: "ssh-1",
      kind: "ssh",
      ssh: {
        host: "127.0.0.1",
        port: 22,
        username: "user",
        privateKeyPath: "C:\\Users\\x\\.ssh\\id_ed25519",
      },
    });
    expect(host).toBeInstanceOf(SshHostSession);
    expect(host.kind).toBe("ssh");
    expect(host.profileId).toBe("ssh-1");
  });

  it("rejects ssh profile without host/username", () => {
    expect(() =>
      createHostForProfile({
        id: "ssh-bad",
        kind: "ssh",
        ssh: { host: "", username: "" },
      }),
    ).toThrow(HostError);
  });

  it("creates wsl host only on Windows", () => {
    if (process.platform !== "win32") {
      expect(() =>
        createHostForProfile({ id: "wsl-default", kind: "wsl" }),
      ).toThrow(/Windows/i);
      return;
    }
    const host = createHostForProfile({
      id: "wsl-default",
      kind: "wsl",
      wsl: { distro: "Ubuntu-24.04" },
    });
    expect(host).toBeInstanceOf(WslHostSession);
    expect(host.kind).toBe("wsl");
    expect(host.profileId).toBe("wsl-default");
  });
});

describe("HostManager", () => {
  let mgr: HostManager;

  afterEach(async () => {
    await mgr?.dispose();
  });

  it("defaults to a local session", () => {
    mgr = new HostManager();
    expect(mgr.kind).toBe("local");
    expect(mgr.session).toBeInstanceOf(LocalHostSession);
    expect(mgr.profileId).toBeTruthy();
  });

  it("accepts an initial session", () => {
    const initial = new LocalHostSession("seed", "local-seed");
    mgr = new HostManager(initial);
    expect(mgr.session).toBe(initial);
    expect(mgr.profileId).toBe("local-seed");
  });

  it("no-ops when useProfile targets the same profile", async () => {
    const initial = new LocalHostSession("seed", "local-default");
    mgr = new HostManager(initial);
    const next = await mgr.useProfile({
      id: "local-default",
      kind: "local",
    });
    expect(next).toBe(initial);
  });

  it("switches local profiles and disposes the previous session", async () => {
    const first = new LocalHostSession("a", "local-a");
    let disposed = false;
    const orig = first.dispose.bind(first);
    first.dispose = async () => {
      disposed = true;
      await orig();
    };
    mgr = new HostManager(first);
    const second = await mgr.useProfile({
      id: "local-b",
      kind: "local",
    });
    expect(second.profileId).toBe("local-b");
    expect(second).not.toBe(first);
    expect(disposed).toBe(true);
    expect(mgr.profileId).toBe("local-b");
  });

  it("ensureLocal returns local when already local", async () => {
    mgr = new HostManager(new LocalHostSession("x", "local-default"));
    const s = await mgr.ensureLocal();
    expect(s.kind).toBe("local");
  });

  it("ensureLocal switches back from non-local profile", async () => {
    if (process.platform !== "win32") {
      // Without WSL/SSH available, switch via ssh profile then ensureLocal.
      mgr = new HostManager();
      await mgr.useProfile({
        id: "ssh-tmp",
        kind: "ssh",
        ssh: { host: "127.0.0.1", username: "u" },
      });
      expect(mgr.kind).toBe("ssh");
      const local = await mgr.ensureLocal();
      expect(local.kind).toBe("local");
      expect(mgr.profileId).toBe("local-default");
      return;
    }
    mgr = new HostManager();
    await mgr.useProfile({
      id: "wsl-default",
      kind: "wsl",
      wsl: { distro: "Ubuntu-24.04" },
    });
    expect(mgr.kind).toBe("wsl");
    const local = await mgr.ensureLocal();
    expect(local.kind).toBe("local");
  });
});
