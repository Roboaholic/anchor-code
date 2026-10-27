// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCliProfile } from "@/shared/anchor-api";
import { NewAgentDialog } from "./NewAgentDialog";
import type { AgentLaunchOptions } from "./terminalStore";
import { useTerminalStore } from "./terminalStore";

const profiles: AgentCliProfile[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: [],
    enabled: true,
    detected: true,
  },
];

describe("NewAgentDialog permission override", () => {
  beforeEach(() => {
    const anchor = {
      agent: {
        launchOptions: vi.fn(async () => ({
          profileId: "claude",
          supportsModel: false,
          supportsEffort: false,
          models: [],
        })),
        sessions: vi.fn(async () => []),
      },
    };
    (window as unknown as { anchor: typeof anchor }).anchor = anchor;
    act(() => {
      useTerminalStore.setState({
        agentProfiles: profiles,
        defaultAgentId: "claude",
        defaultAgentPermissionMode: "full-access",
        workgroups: [
          {
            id: "default",
            name: "Default",
            createdAt: "2020-01-01T00:00:00.000Z",
          },
        ],
        activeGroupId: "default",
      });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults override to global full-access and passes selection on open", async () => {
    const onOpen = vi.fn(
      async (_profile: AgentCliProfile, _launch: AgentLaunchOptions) => true,
    );
    render(
      <NewAgentDialog
        profiles={profiles}
        defaultAgentId="claude"
        onOpen={onOpen}
        onDetect={() => undefined}
        onClose={() => undefined}
        hideResume
      />,
    );
    await waitFor(() => screen.getByTestId("agent-new-permission"));
    const row = screen.getByTestId("agent-new-permission");
    expect(row.querySelector('[aria-checked="true"]')?.textContent).toMatch(
      /Full access/i,
    );
    const cliDefault = Array.from(row.querySelectorAll('[role="radio"]')).find(
      (b) => b.textContent === "CLI default",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(cliDefault);
    });
    const openBtn = screen.getByRole("button", { name: /^Open$/ });
    await act(async () => {
      fireEvent.click(openBtn);
    });
    await waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(onOpen.mock.calls[0]?.[1]).toMatchObject({
      permissionMode: "cli-default",
    });
  });
});
