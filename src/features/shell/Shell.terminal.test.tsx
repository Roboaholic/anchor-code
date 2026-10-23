// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/workspace/workspaceStore";
import { useTerminalStore } from "@/features/terminal/terminalStore";
import { useThemeStore } from "./themeStore";
import { useShellStore } from "./shellStore";
import { Shell } from "./Shell";

const { scheduleFit } = vi.hoisted(() => ({ scheduleFit: vi.fn() }));
vi.mock("@/features/document/DocumentArea", () => ({ DocumentArea: () => <div>Document surface</div> }));
vi.mock("@/features/workspace/OpenWorkspaceDialog", () => ({ OpenWorkspaceDialog: () => null }));
vi.mock("@/features/annotations/CommentsPane", () => ({ CommentsPane: () => null }));
vi.mock("@/features/files/FileTree", () => ({ FileTree: () => null }));
vi.mock("@/features/terminal/AgentSidebar", () => ({ AgentSidebar: () => <div>Agent sidebar</div> }));
vi.mock("@/features/terminal/NewAgentDialogHost", () => ({ NewAgentDialogHost: () => null }));
vi.mock("@/features/ask/AskDialog", () => ({ AskDialog: () => null }));
vi.mock("./QuickOpen", () => ({ QuickOpenPalette: () => null, warmFileIndexCache: vi.fn() }));
vi.mock("./TerminalPanel", () => ({
  TerminalPanel: ({ mode }: { mode: string }) => <div data-testid={`terminal-surface-${mode}`} />,
}));
vi.mock("./orchestrate", () => ({
  openWorkspaceWithHost: vi.fn(), restoreLastWorkspaceOnLaunch: vi.fn(),
}));
vi.mock("@/features/terminal/xtermSessionPool", () => ({
  fitXtermSession: vi.fn(), scheduleFitXtermSession: scheduleFit,
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useShellStore.setState(useShellStore.getInitialState(), true);
  useWorkspaceStore.setState({
    workspaceRoot: "/repo", workspaceName: "repo", hostKind: "local", hostProfileId: "local-default",
    openWorkspaces: [], loadRecent: vi.fn(async () => {}), loadOpenWorkspaces: vi.fn(async () => {}),
  });
  useTerminalStore.setState({
    tabs: [], activeByMode: { terminal: "shell-1", agent: null }, agentMenuOpen: false,
  });
  useThemeStore.setState({ hydrate: vi.fn(async () => {}), settingsOpen: false });
  Object.assign(window, { anchor: { shell: { getVersion: vi.fn(async () => ({ app: "test", hostKind: "local" })) } } });
});

afterEach(() => cleanup());

function terminalPanel(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-panel-id="terminal-bottom"]')!;
}

describe("shell terminal in Agent workbench", () => {
  it("opens and closes from the toolbar while retaining the Agent page", async () => {
    const { container } = render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "AGENT" }));
    expect(screen.getByText("Agent sidebar")).toBeTruthy();
    expect(screen.getByTestId("terminal-surface-agent")).toBeTruthy();
    expect(terminalPanel(container).getAttribute("data-panel-size")).toBe("0.0");

    const toggle = screen.getByRole("button", { name: "Toggle terminal panel" });
    fireEvent.click(toggle);
    await waitFor(() => expect(Number(terminalPanel(container).getAttribute("data-panel-size"))).toBeGreaterThan(0));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("terminal-surface-terminal")).toBeTruthy();
    expect(screen.getByTestId("terminal-surface-agent")).toBeTruthy();
    expect(useShellStore.getState().leftMode).toBe("agent");
    expect(scheduleFit).toHaveBeenCalledWith("shell-1", 220);

    fireEvent.click(toggle);
    await waitFor(() => expect(Number(terminalPanel(container).getAttribute("data-panel-size"))).toBe(0));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(useShellStore.getState().leftMode).toBe("agent");
  });

  it("keeps an open terminal mounted and expanded when switching between Files and Agent", async () => {
    useShellStore.setState({ terminalVisible: true });
    const { container } = render(<Shell />);
    const surface = screen.getByTestId("terminal-surface-terminal");
    fireEvent.click(screen.getByRole("button", { name: "AGENT" }));
    await waitFor(() => expect(Number(terminalPanel(container).getAttribute("data-panel-size"))).toBeGreaterThan(0));
    expect(screen.getByTestId("terminal-surface-terminal")).toBe(surface);
    fireEvent.click(screen.getByRole("button", { name: "FILES" }));
    expect(screen.getByTestId("terminal-surface-terminal")).toBe(surface);
    expect(Number(terminalPanel(container).getAttribute("data-panel-size"))).toBeGreaterThan(0);

    act(() => useWorkspaceStore.setState({ workspaceRoot: null }));
    await waitFor(() => expect(Number(terminalPanel(container).getAttribute("data-panel-size"))).toBe(0));
    expect(screen.queryByTestId("terminal-surface-terminal")).toBeNull();
  });
});
