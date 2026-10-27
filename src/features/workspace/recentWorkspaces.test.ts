import { describe, expect, it } from "vitest";
import type { HostProfile, RecentWorkspace } from "@/shared/anchor-api";
import {
  buildRecentWorkspaceViews,
  formatRecentMeta,
  formatRecentOpenedAt,
  hostIconName,
  hostLabelForProfile,
  workspaceFolderName,
} from "./recentWorkspaces";

describe("recentWorkspaces helpers", () => {
  it("extracts folder names from POSIX and Windows paths", () => {
    expect(workspaceFolderName("/data/miles/pyoneer3")).toBe("pyoneer3");
    expect(workspaceFolderName("C:\\Users\\miles\\proj\\")).toBe("proj");
    expect(workspaceFolderName("/")).toBe("/");
  });

  it("formats muted path · host meta", () => {
    expect(formatRecentMeta("/data/miles/pyoneer3", "pyoneer3")).toBe("/data/miles/pyoneer3 · pyoneer3");
    expect(formatRecentMeta("/home/miles/app", "WSL (Ubuntu)")).toBe("/home/miles/app · WSL (Ubuntu)");
    expect(formatRecentMeta("/tmp/x", "")).toBe("/tmp/x");
  });

  it("formats relative opened times", () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    expect(formatRecentOpenedAt("2026-10-27T11:55:00.000Z", now)).toBe("5m");
    expect(formatRecentOpenedAt("2026-10-27T09:00:00.000Z", now)).toBe("3h");
    expect(formatRecentOpenedAt("2026-10-25T12:00:00.000Z", now)).toBe("2d");
  });

  it("picks host icons and labels from profiles", () => {
    expect(hostIconName("local")).toBe("device-desktop");
    expect(hostIconName("wsl")).toBe("terminal-linux");
    expect(hostIconName("ssh")).toBe("remote");

    const local: HostProfile = { id: "local-default", kind: "local" };
    const wsl: HostProfile = { id: "wsl-default", kind: "wsl", wsl: { distro: "Ubuntu" }, label: "WSL (Ubuntu)" };
    const ssh: HostProfile = {
      id: "ssh-config-pyoneer3",
      kind: "ssh",
      label: "pyoneer3",
      ssh: { configHost: "pyoneer3" },
    };
    expect(hostLabelForProfile(local, "local-default")).toBe("This computer");
    expect(hostLabelForProfile(wsl, "wsl-default")).toBe("WSL (Ubuntu)");
    expect(hostLabelForProfile(ssh, "ssh-config-pyoneer3")).toBe("pyoneer3");
  });

  it("builds display rows in recent order and falls back when profile is missing", () => {
    const recent: RecentWorkspace[] = [
      { path: "/data/miles/pyoneer3", hostProfileId: "ssh-config-pyoneer3", lastOpenedAt: "2026-10-27T10:00:00.000Z" },
      { path: "/home/miles/app", hostProfileId: "wsl-default", lastOpenedAt: "2026-10-26T10:00:00.000Z" },
      { path: "/tmp/local-proj", hostProfileId: "local-default", lastOpenedAt: "2026-10-25T10:00:00.000Z" },
      { path: "/gone", hostProfileId: "missing-profile", lastOpenedAt: "2026-10-24T10:00:00.000Z" },
    ];
    const profiles: HostProfile[] = [
      { id: "local-default", kind: "local" },
      { id: "wsl-default", kind: "wsl", wsl: { distro: "Ubuntu" } },
      { id: "ssh-config-pyoneer3", kind: "ssh", ssh: { configHost: "pyoneer3" }, label: "pyoneer3" },
    ];
    const views = buildRecentWorkspaceViews(recent, profiles);
    expect(views.map((v) => v.name)).toEqual(["pyoneer3", "app", "local-proj", "gone"]);
    expect(views[0].hostKind).toBe("ssh");
    expect(views[1].hostKind).toBe("wsl");
    expect(views[2].hostKind).toBe("local");
    expect(views[3].hostKind).toBe("local");
    expect(views[3].hostLabel).toBe("missing-profile");
  });
});
