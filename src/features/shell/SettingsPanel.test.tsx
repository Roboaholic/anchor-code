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

describe("SettingsPanel", () => {
  beforeEach(() => {
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

  it("shows Appearance, Agent, Updates — not Agent skill or mobile", () => {
    render(<SettingsPanel />);
    act(() => useThemeStore.getState().setSettingsOpen(true));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const items = Array.from(nav.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["Appearance", "Agent", "Updates"]);
    expect(screen.queryByText(/^Agent skill$/)).toBeNull();
    expect(screen.queryByText(/mobile access/i)).toBeNull();
    expect(screen.queryByText(/pairing/i)).toBeNull();
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
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
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
});
