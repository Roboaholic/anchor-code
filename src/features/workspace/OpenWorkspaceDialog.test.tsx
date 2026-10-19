// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog";

interface AnchorMock {
  host: {
    listProfiles: ReturnType<typeof vi.fn>;
    listSshConfigHosts: ReturnType<typeof vi.fn>;
    listWslDistros: ReturnType<typeof vi.fn>;
    wslHome: ReturnType<typeof vi.fn>;
    browseListDir: ReturnType<typeof vi.fn>;
    useProfile: ReturnType<typeof vi.fn>;
    upsertProfile: ReturnType<typeof vi.fn>;
  };
  workspace: {
    pickFolder: ReturnType<typeof vi.fn>;
  };
}

function getAnchor(): AnchorMock {
  return (window as unknown as { anchor: AnchorMock }).anchor;
}

function installAnchor(pickFolder?: ReturnType<typeof vi.fn>): AnchorMock {
  const anchor: AnchorMock = {
    host: {
      listProfiles: vi.fn(async () => [
        { id: "local-default", kind: "local" as const, label: "Local" },
        { id: "wsl-default", kind: "wsl" as const, label: "WSL" },
      ]),
      listSshConfigHosts: vi.fn(async () => ({ hosts: [], warnings: [] })),
      listWslDistros: vi.fn(async () => ["Ubuntu-24.04"]),
      wslHome: vi.fn(async () => "/home/tester"),
      browseListDir: vi.fn(async (args: { path: string }) => {
        if (args.path === "/home/tester") {
          return [
            { name: "repo-a", type: "dir" as const },
            { name: "repo-b", type: "dir" as const },
            { name: "readme.md", type: "file" as const },
            { name: ".config", type: "dir" as const },
          ];
        }
        if (args.path === "/home/tester/repo-a") {
          return [{ name: "src", type: "dir" as const }];
        }
        if (args.path === "/home") {
          return [{ name: "tester", type: "dir" as const }];
        }
        return [];
      }),
      useProfile: vi.fn(async (id: string) => ({
        id: "host-1",
        kind: id.includes("wsl") ? ("wsl" as const) : ("local" as const),
        profileId: id,
      })),
      upsertProfile: vi.fn(async (p: unknown) => [p]),
    },
    workspace: {
      pickFolder: pickFolder ?? vi.fn(async () => null),
    },
  };
  Object.assign(window, { anchor });
  return anchor;
}

function setWindowsUa(win: boolean) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    get: () =>
      win
        ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
}

describe("OpenWorkspaceDialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("on Windows", () => {
    let anchor: AnchorMock;

    beforeEach(() => {
      setWindowsUa(true);
      anchor = installAnchor();
    });

    it("renders nothing when closed", () => {
      const { container } = render(
        <OpenWorkspaceDialog open={false} onClose={() => {}} onOpen={() => {}} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("defaults to WSL and loads home folders", async () => {
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );

      expect(
        screen.getByRole("dialog", { name: /open workspace/i }),
      ).toBeTruthy();
      expect(screen.getByText("WSL").closest("label")?.className).toMatch(
        /is-selected/,
      );

      await waitFor(() => {
        expect(anchor.host.wslHome).toHaveBeenCalled();
        expect(anchor.host.browseListDir).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByText("repo-a")).toBeTruthy();
        expect(screen.getByText("repo-b")).toBeTruthy();
      });
      expect(screen.queryByText("readme.md")).toBeNull();
      expect(screen.queryByText(".config")).toBeNull();
      expect(
        document.querySelector(".wsl-browser__path")?.textContent,
      ).toBe("/home/tester");
    });

    it("enters a folder on click and can go up", async () => {
      const user = userEvent.setup();
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );
      await waitFor(() => expect(screen.getByText("repo-a")).toBeTruthy());

      await user.click(screen.getByText("repo-a"));
      await waitFor(() => {
        expect(anchor.host.browseListDir).toHaveBeenCalledWith(
          expect.objectContaining({ path: "/home/tester/repo-a" }),
        );
      });
      await waitFor(() => expect(screen.getByText("src")).toBeTruthy());

      await user.click(screen.getByRole("button", { name: /up/i }));
      await waitFor(() => {
        expect(anchor.host.browseListDir).toHaveBeenCalledWith(
          expect.objectContaining({ path: "/home/tester" }),
        );
      });
    });

    it("opens WSL workspace with selected path", async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const onClose = vi.fn();
      render(
        <OpenWorkspaceDialog open onClose={onClose} onOpen={onOpen} />,
      );
      await waitFor(() => expect(screen.getByText("repo-a")).toBeTruthy());

      await user.click(
        screen.getByRole("button", { name: /^open workspace$/i }),
      );

      await waitFor(() => {
        expect(anchor.host.useProfile).toHaveBeenCalledWith("wsl-default");
        expect(onOpen).toHaveBeenCalledWith({
          path: "/home/tester",
          hostProfileId: "wsl-default",
          hostKind: "wsl",
        });
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("switches to Local and uses system picker", async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const onClose = vi.fn();
      anchor.workspace.pickFolder = vi.fn(async () => "C:\\Users\\tester\\proj");
      render(
        <OpenWorkspaceDialog open onClose={onClose} onOpen={onOpen} />,
      );

      const localLabel = screen.getByText("Local").closest("label");
      expect(localLabel).toBeTruthy();
      await user.click(localLabel!);

      await waitFor(() => {
        expect(screen.getByText(/Local workspace/i)).toBeTruthy();
      });

      await user.click(
        screen.getByRole("button", { name: /choose folder/i }),
      );

      await waitFor(() => {
        expect(anchor.host.useProfile).toHaveBeenCalledWith("local-default");
        expect(anchor.workspace.pickFolder).toHaveBeenCalled();
        expect(onOpen).toHaveBeenCalledWith({
          path: "C:\\Users\\tester\\proj",
          hostProfileId: "local-default",
          hostKind: "local",
        });
        expect(onClose).toHaveBeenCalled();
      });
    });

    it("closes when Cancel is clicked", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <OpenWorkspaceDialog open onClose={onClose} onOpen={() => {}} />,
      );
      await user.click(screen.getByRole("button", { name: /cancel/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it("shows browse error from host", async () => {
      anchor.host.browseListDir = vi.fn(async () => {
        throw new Error("UNC path unavailable");
      });
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText(/UNC path unavailable/i)).toBeTruthy();
      });
    });
  });

  describe("on non-Windows", () => {
    beforeEach(() => {
      setWindowsUa(false);
      installAnchor();
    });

    it("only offers Local (no WSL card)", async () => {
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );
      expect(screen.getByText("Local")).toBeTruthy();
      expect(screen.queryByText("WSL")).toBeNull();
      expect(screen.getByText(/Local workspace/i)).toBeTruthy();
      expect(getAnchor().host.listWslDistros).not.toHaveBeenCalled();
    });
  });
});

describe("SSH workspace connections", () => {
  let anchor: AnchorMock;
  beforeEach(() => {
    setWindowsUa(false);
    anchor = installAnchor();
    anchor.host.listSshConfigHosts.mockResolvedValue({ hosts: [{ alias: "work", source: "/home/test/.ssh/config" }, { alias: "jump-work", source: "/home/test/.ssh/config.d/work" }], warnings: [] });
    anchor.host.browseListDir.mockResolvedValue([{ name: "project", type: "dir" }]);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  async function showSsh(onOpen = vi.fn(), onClose = vi.fn()) {
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onOpen={onOpen} onClose={onClose} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByText("SSH").closest("label")!);
    await waitFor(() => expect((screen.getByLabelText("SSH config host") as HTMLInputElement).value).toBe("work"));
    return user;
  }

  it("defaults to discovered aliases and only connects on request", async () => {
    const onOpen = vi.fn();
    const user = await showSsh(onOpen);
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(anchor.host.upsertProfile).not.toHaveBeenCalled();
    expect(anchor.host.browseListDir).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("project")).toBeTruthy());
    expect(anchor.host.upsertProfile).toHaveBeenCalledWith({ id: "ssh-config-work", kind: "ssh", label: "work", ssh: { configHost: "work" } });
    await user.click(screen.getByText("project"));
    await waitFor(() => expect(anchor.host.browseListDir).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/project" })));
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    expect(onOpen).toHaveBeenCalledWith({ path: "/project", hostProfileId: "ssh-config-work", hostKind: "ssh" });
  });

  it("invalidates a connected profile when selecting a different alias", async () => {
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy());
    await user.clear(screen.getByLabelText("SSH config host"));
    await user.type(screen.getByLabelText("SSH config host"), "jump-work");
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
    expect(anchor.host.upsertProfile).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(anchor.host.upsertProfile).toHaveBeenLastCalledWith(expect.objectContaining({ ssh: { configHost: "jump-work" } })));
  });

  it("keeps adding manual connections available and preserves password until explicit connect", async () => {
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Add / manual connection" }));
    await user.type(screen.getByRole("textbox", { name: "Host" }), "example.test");
    await user.type(screen.getByLabelText("Username"), "tester");
    await user.type(screen.getByLabelText("Password (this session only)"), "test-password");
    expect(anchor.host.upsertProfile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(anchor.host.upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ ssh: { host: "example.test", port: 22, username: "tester", password: "test-password", knownHostsPolicy: "strict" } })));
  });

  it("falls back to a manual form when no aliases exist, with direct alias entry still available", async () => {
    anchor.host.listSshConfigHosts.mockResolvedValue({ hosts: [], warnings: [] });
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onOpen={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByText("SSH").closest("label")!);
    expect(screen.getByLabelText("Username")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use SSH config" }));
    expect(screen.getByLabelText("SSH config host")).toBeTruthy();
  });

  it("surfaces verification failures without enabling Open Workspace", async () => {
    anchor.host.browseListDir.mockRejectedValue(new Error("Host key verification failed for work. Verify the fingerprint in a terminal."));
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText(/Host key verification failed for work/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores a connection result after Close and avoids duplicate connects", async () => {
    let resolveBrowse!: (value: unknown[]) => void;
    anchor.host.browseListDir.mockImplementation(() => new Promise((resolve) => { resolveBrowse = resolve; }));
    const onOpen = vi.fn(); const onClose = vi.fn();
    const user = await showSsh(onOpen, onClose);
    await user.dblClick(screen.getByRole("button", { name: "Connect" }));
    expect(anchor.host.upsertProfile).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close" }));
    resolveBrowse([{ name: "late-folder", type: "dir" }]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("late-folder")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("does not let a delayed WSL home replace connected SSH folders", async () => {
    setWindowsUa(true);
    let resolveHome!: (home: string) => void;
    anchor.host.wslHome.mockImplementation(() => new Promise<string>((resolve) => { resolveHome = resolve; }));
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("project")).toBeTruthy());
    await user.click(screen.getByText("project"));
    await waitFor(() => expect(document.querySelector(".wsl-browser__path")?.textContent).toBe("/project"));
    resolveHome("/home/wsl-user");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".wsl-browser__path")?.textContent).toBe("/project");
    expect(anchor.host.browseListDir).not.toHaveBeenCalledWith(expect.objectContaining({ path: "/home/wsl-user" }));
  });

  it("preserves user edits when SSH config discovery finishes late", async () => {
    let resolveConfig!: (value: { hosts: { alias: string; source: string }[]; warnings: string[] }) => void;
    anchor.host.listSshConfigHosts.mockImplementation(() => new Promise((resolve) => { resolveConfig = resolve; }));
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onOpen={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByText("SSH").closest("label")!);
    await user.click(screen.getByRole("button", { name: "Add / manual connection" }));
    await user.type(screen.getByRole("textbox", { name: "Host" }), "typed-host");
    resolveConfig({ hosts: [{ alias: "late", source: "config" }], warnings: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((screen.getByRole("textbox", { name: "Host" }) as HTMLInputElement).value).toBe("typed-host");
    expect(screen.queryByLabelText("SSH config host")).toBeNull();
  });

  it("cannot dismiss midway through committing the active SSH workspace", async () => {
    let resolveUse!: (value: unknown) => void;
    anchor.host.useProfile.mockImplementation(() => new Promise((resolve) => { resolveUse = resolve; }));
    const onOpen = vi.fn(); const onClose = vi.fn();
    const user = await showSsh(onOpen, onClose);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    resolveUse({ id: "ssh", kind: "ssh", profileId: "ssh-config-work" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ path: "/", hostProfileId: "ssh-config-work", hostKind: "ssh" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

});
