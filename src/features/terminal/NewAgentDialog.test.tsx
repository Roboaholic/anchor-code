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

describe("NewAgentDialog permission segmented control CSS", () => {
  it("lets permission segmented control escape the 18px toolbar pill", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(
      path.resolve(__dirname, "../../styles/global.css"),
      "utf8",
    );
    const styleFor = (selector: string, source = css) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        `(^|\\s|})(${escaped})\\s*{([^}]*)}`,
        "g",
      );
      const matches = [...source.matchAll(re)];
      expect(matches.length, `Missing CSS rule: ${selector}`).toBeGreaterThan(0);
      const body = matches.map((rule) => rule[3]).join(";");
      return Object.fromEntries(
        body
          .split(";")
          .filter((declaration) => declaration.includes(":"))
          .map((declaration) => {
            const colon = declaration.indexOf(":");
            return [
              declaration.slice(0, colon).trim(),
              declaration.slice(colon + 1).trim(),
            ];
          }),
      );
    };
    const unlocked = styleFor(".repo-seg.anchor-seg");
    expect(unlocked.height).toBe("28px");
    expect(unlocked["margin-left"]).toBe("0");
    expect(unlocked["align-items"]).toBe("stretch");
    expect(unlocked.padding).toBe("2px");
    const btn = styleFor(".anchor-seg .repo-seg__btn");
    expect(btn.height).toBe("100%");
    expect(btn["min-height"]).toBe("0");
    expect(btn.padding).toBe("0 8px");
    expect(btn["align-items"]).toBe("center");
    expect(btn["justify-content"]).toBe("center");
    expect(btn["line-height"]).toBe("1");
    const sm = styleFor(".anchor-seg--sm .repo-seg__btn");
    expect(sm.padding).toBe("0 6px");
    expect(sm["min-height"]).toBe("0");
    // Toolbar All/Tracked keeps the fixed 18px pill (raw .repo-seg, no .anchor-seg).
    expect(styleFor(".repo-seg").height).toBe("18px");
  });
});
