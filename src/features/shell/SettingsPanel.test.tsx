// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { useThemeStore } from "./themeStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";

const profiles = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: [] as string[],
    enabled: true,
    detected: true,
  },
  {
    id: "pi",
    name: "Pi",
    command: "pi",
    args: [] as string[],
    enabled: true,
    detected: false,
  },
];

function remoteInfo(enabled: boolean) {
  return {
    enabled,
    relay: {
      enabled,
      state: enabled ? ("connecting" as const) : ("disabled" as const),
      url: enabled ? "https://relay.invalid" : "",
      roomId: "",
      hostPeerId: "",
      connectedGuests: 0,
      devices: [],
      pendingDevices: [],
    },
  };
}

describe("SettingsPanel", () => {
  let remoteOn = false;
  beforeEach(() => {
    remoteOn = false;
    const anchor = {
      settings: {
        getRestoreLastWorkspace: vi.fn(async () => true),
        setRestoreLastWorkspace: vi.fn(async (v: boolean) => v),
        getTheme: vi.fn(async () => "dark-modern"),
        setTheme: vi.fn(async (t: string) => t),
        getSessionTabLayout: vi.fn(async () => "side"),
        setSessionTabLayout: vi.fn(async (v: string) => v),
        getFontSize: vi.fn(async () => 13),
        setFontSize: vi.fn(async (n: number) => n),
        getEditorFontFamily: vi.fn(async () => "SF Mono, JetBrains Mono, Menlo, Monaco, Consolas, 'Courier New', monospace"),
        setEditorFontFamily: vi.fn(async (v: string) => v),
        getLineHeight: vi.fn(async () => 1.5),
        setLineHeight: vi.fn(async (n: number) => n),
        getUiScale: vi.fn(async () => 100),
        setUiScale: vi.fn(async (n: number) => n),
      },
      updates: {
        getState: vi.fn(async () => null),
        onState: vi.fn(() => () => undefined),
        check: vi.fn(async () => null),
        download: vi.fn(async () => null),
        install: vi.fn(async () => ({ ok: true })),
        openReleasePage: vi.fn(async () => ({ ok: true })),
      },
      agent: {
        listProfiles: vi.fn(async () => profiles),
        getDefaultId: vi.fn(async () => "claude"),
        setDefaultId: vi.fn(async () => undefined),
        detect: vi.fn(async () =>
          profiles.map((p) => ({ ...p, detected: true })),
        ),
        upsertProfile: vi.fn(async (p: (typeof profiles)[0]) => {
          const idx = profiles.findIndex((x) => x.id === p.id);
          if (idx >= 0) profiles[idx] = { ...profiles[idx], ...p };
          return [...profiles];
        }),
        saveProfiles: vi.fn(async (list: typeof profiles) => list),
      },
      remote: {
        getInfo: vi.fn(async () => remoteInfo(remoteOn)),
        update: vi.fn(async (v: { enabled?: boolean }) => {
          remoteOn = v.enabled === true;
          return remoteInfo(remoteOn);
        }),
        approveDevice: vi.fn(async () => remoteInfo(true)),
        revokeDevice: vi.fn(async () => remoteInfo(true)),
      },
      skill: {
        status: vi.fn(async () => ({ targets: [] })),
        install: vi.fn(async () => ({ ok: true, installed: [] })),
      },
    };
    (window as unknown as { anchor: typeof anchor }).anchor = anchor;
    act(() => {
      useTerminalStore.setState({
        agentProfiles: profiles,
        defaultAgentId: "claude",
      });
    });
  });

  afterEach(() => {
    cleanup();
    act(() => useThemeStore.getState().setSettingsOpen(false));
  });

  it("shows Appearance, Agent, Updates, Experimental — mobile access only under Experimental", () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().setSettingsOpen(true));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const items = Array.from(nav.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["Appearance", "Agent", "Updates", "Experimental"]);
    expect(screen.queryByText(/^Agent skill$/)).toBeNull();
    // Not on the default page.
    expect(screen.queryByText(/^Mobile access$/)).toBeNull();
  });

  it("Experimental shows Mobile access with the relay off and no QR until enabled", async () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().openSettings("experimental"));
    await waitFor(() => screen.getByText(/^Mobile access$/));
    expect(screen.getByRole("note").textContent).toMatch(/experimental/i);
    await waitFor(() => expect(window.anchor.remote.getInfo).toHaveBeenCalled());
    const toggle = screen.getByTestId("mobile-access-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("mobile-access-state").textContent).toBe("disabled");
    expect(screen.getByText(/Turn on Mobile access to show a pairing code/)).toBeTruthy();
    // Opening the page must not start the relay by itself.
    expect(window.anchor.remote.update).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => {
      expect(window.anchor.remote.update).toHaveBeenCalledWith({ enabled: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId("mobile-access-toggle").getAttribute("aria-checked")).toBe("true");
    });
  });

  it("does not render a native title tooltip in the Experimental page", async () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().openSettings("experimental"));
    await waitFor(() => screen.getByText(/^Mobile access$/));
    const section = screen.getByLabelText("Experimental");
    expect(section.querySelector("[title]")).toBeNull();
  });

  it("opens Agent section via agent-skill focus alias", async () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().openSettings("agent-skill"));
    await waitFor(() => {
      expect(screen.getByLabelText("Agent")).toBeTruthy();
    });
    expect(screen.getByTestId("settings-agent-list")).toBeTruthy();
    expect(screen.getByText("Anchor Review skill")).toBeTruthy();
  });

  it("toggles agent enabled and persists via upsertProfile", async () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().openSettings("agent"));
    await waitFor(() => screen.getByTestId("settings-agent-row-pi"));
    const row = screen.getByTestId("settings-agent-row-pi");
    const checkbox = row.querySelector(
      '[role="switch"]',
    ) as HTMLButtonElement;
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(checkbox);
    });
    await waitFor(() => {
      expect(window.anchor.agent.upsertProfile).toHaveBeenCalled();
    });
    const call = vi.mocked(window.anchor.agent.upsertProfile).mock.calls.at(-1);
    expect(call?.[0]).toMatchObject({ id: "pi", enabled: false });
  });

  it("shows font family and line height on Appearance", () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().setSettingsOpen(true));
    expect(screen.getByTestId("settings-font-family")).toBeTruthy();
    expect(screen.getByTestId("settings-line-height")).toBeTruthy();
  });

  it("reuses cached available update state without forcing Check for updates", async () => {
    const available = {
      status: "available" as const,
      currentVersion: "0.1.69",
      latestVersion: "0.1.70",
      releaseUrl: "https://github.com/Roboaholic/anchor-code/releases/tag/v0.1.70",
      canInstall: false,
      packaged: true,
      progress: null,
      message: "Version 0.1.70 is available.",
      error: null,
    };
    vi.mocked(window.anchor.updates.getState).mockResolvedValue(available);

    render(<SettingsPanel />);
    act(() => useThemeStore.getState().openSettings("updates"));

    await waitFor(() => {
      expect(screen.getByText("Download update")).toBeTruthy();
    });
    expect(screen.getByText("v0.1.70")).toBeTruthy();
    expect(window.anchor.updates.check).not.toHaveBeenCalled();
  });

  it("auto-checks Updates when main process has no actionable state yet", async () => {
    const idle = {
      status: "idle" as const,
      currentVersion: "0.1.69",
      latestVersion: null,
      releaseUrl: null,
      canInstall: false,
      packaged: true,
      progress: null,
      message: null,
      error: null,
    };
    const afterCheck = {
      ...idle,
      status: "not-available" as const,
      latestVersion: "0.1.69",
      message: "You're on the latest version.",
    };
    vi.mocked(window.anchor.updates.getState).mockResolvedValue(idle);
    vi.mocked(window.anchor.updates.check).mockResolvedValue(afterCheck);

    render(<SettingsPanel />);
    act(() => useThemeStore.getState().openSettings("updates"));

    await waitFor(() => {
      expect(window.anchor.updates.check).toHaveBeenCalled();
    });
  });
});
