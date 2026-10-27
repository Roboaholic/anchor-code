// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog";
import { readFileSync } from "node:fs";

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
    getRecent: ReturnType<typeof vi.fn>;
    removeRecent: ReturnType<typeof vi.fn>;
    listDir: ReturnType<typeof vi.fn>;
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
      getRecent: vi.fn(async () => []),
      removeRecent: vi.fn(async () => []),
      listDir: vi.fn(async () => []),
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

function ReopenableDialog({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Reopen workspace dialog</button>
    <OpenWorkspaceDialog open={open} onOpen={() => {}} onClose={() => { onClose(); setOpen(false); }} />
  </>;
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
      expect(
        screen.getByRole("radio", { name: "WSL" }).getAttribute("aria-checked"),
      ).toBe("true");

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
        (screen.getByLabelText("Folder path") as HTMLInputElement).value,
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

      await user.click(screen.getByRole("radio", { name: "Local" }));

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

    it("shows a friendly notice instead of browsing when WSL has no distros", async () => {
      anchor.host.listWslDistros = vi.fn(async () => []);
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByText("WSL isn't installed or has no distros")).toBeTruthy();
      });
      expect(screen.queryByText(/No distros listed/i)).toBeNull();
      expect(screen.queryByLabelText("Folder path")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(anchor.host.wslHome).not.toHaveBeenCalled();
      expect(anchor.host.browseListDir).not.toHaveBeenCalled();
      expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText("WSL is not available")).toBeTruthy();
    });

    it("treats a failing WSL probe as unavailable and can check again", async () => {
      anchor.host.listWslDistros = vi
        .fn()
        .mockRejectedValueOnce(new Error("wsl.exe not found"))
        .mockResolvedValue(["Debian"]);
      const user = userEvent.setup();
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      });
      expect(screen.queryByText(/wsl\.exe not found/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => {
        expect(screen.getByText("repo-a")).toBeTruthy();
      });
      expect(anchor.host.wslHome).toHaveBeenCalledWith({ distro: "Debian" });
      expect(screen.getByText("Distro")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("keeps Open Workspace disabled until WSL detection finishes", async () => {
      let resolveDistros!: (list: string[]) => void;
      anchor.host.listWslDistros = vi.fn(() => new Promise<string[]>((resolve) => { resolveDistros = resolve; }));
      render(
        <OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />,
      );
      expect(screen.getByText("Looking for WSL distros…")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
      expect(anchor.host.browseListDir).not.toHaveBeenCalled();
      await act(async () => { resolveDistros(["Ubuntu-24.04"]); });
      await waitFor(() => expect(screen.getByText("repo-a")).toBeTruthy());
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
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    await waitFor(() => expect((screen.getByLabelText("SSH config host") as HTMLInputElement).value).toBe("work"));
    return user;
  }

  it("defaults to discovered aliases and only connects on request", async () => {
    const onOpen = vi.fn();
    const user = await showSsh(onOpen);
    expect(screen.getByRole("heading", { name: "Connect to a host" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "SSH workspace steps" })).toBeNull();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(anchor.host.upsertProfile).not.toHaveBeenCalled();
    expect(anchor.host.browseListDir).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open Workspace" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("project")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Choose a folder" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "SSH workspace steps" })).toBeNull();
    expect(anchor.host.upsertProfile).toHaveBeenCalledWith({ id: "ssh-config-work", kind: "ssh", label: "work", ssh: { configHost: "work" } });
    await user.click(screen.getByText("project"));
    await waitFor(() => expect(anchor.host.browseListDir).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/project" })));
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    expect(onOpen).toHaveBeenCalledWith({ path: "/project", hostProfileId: "ssh-config-work", hostKind: "ssh" });
  });

  it("reuses the application's flat action and mode button styles", async () => {
    const user = await showSsh();
    expect(screen.getByRole("button", { name: "Connect" }).className).toBe("btn btn--accent");
    expect(screen.getByRole("button", { name: "Use SSH config" }).className).toBe("btn btn--ghost btn--small is-active");
    await user.click(screen.getByRole("button", { name: "Manual connection" }));
    expect(screen.getByRole("button", { name: "Manual connection" }).className).toBe("btn btn--ghost btn--small is-active");
    expect(screen.getByRole("button", { name: "Use SSH config" }).className).toBe("btn btn--ghost btn--small");
  });

  it.each(["Close", "Cancel", "Escape"])("%s dismisses while loading and ignores a late result after reopening", async (control) => {
    let resolveBrowse!: (value: unknown[]) => void;
    anchor.host.browseListDir.mockImplementationOnce(() => new Promise((resolve) => { resolveBrowse = resolve; }));
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReopenableDialog onClose={onClose} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(anchor.host.browseListDir).toHaveBeenCalledTimes(1));

    if (control === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: control }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reopen workspace dialog" }));
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalledTimes(2));
    await act(async () => { resolveBrowse([{ name: "stale-folder", type: "dir" }]); });
    expect(screen.queryByText("stale-folder")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Workspace" })).toBeNull();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("project")).toBeTruthy());
    expect(anchor.host.browseListDir).toHaveBeenCalledTimes(2);
  });

  it.each(["Close", "Cancel", "Escape"])("%s dismisses loaded folders and reopens with a fresh connection", async (control) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReopenableDialog onClose={onClose} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("project")).toBeTruthy());

    if (control === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: control }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reopen workspace dialog" }));
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("project")).toBeNull();
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps Close usable after an error", async () => {
    anchor.host.browseListDir.mockRejectedValue(new Error("Permission denied"));
    const onClose = vi.fn();
    const user = await showSsh(vi.fn(), onClose);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("invalidates a connected profile when selecting a different alias", async () => {
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Change connection" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    await user.clear(screen.getByLabelText("SSH config host"));
    await user.type(screen.getByLabelText("SSH config host"), "jump-work");
    expect(screen.queryByRole("button", { name: "Open Workspace" })).toBeNull();
    expect(anchor.host.upsertProfile).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(anchor.host.upsertProfile).toHaveBeenLastCalledWith(expect.objectContaining({ ssh: { configHost: "jump-work" } })));
  });

  it("keeps adding manual connections available and preserves password until explicit connect", async () => {
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Manual connection" }));
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
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    expect(screen.getByLabelText("Username")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use SSH config" }));
    expect(screen.getByLabelText("SSH config host")).toBeTruthy();
  });

  it("surfaces verification failures without enabling Open Workspace", async () => {
    anchor.host.browseListDir.mockRejectedValue(new Error("Host key verification failed for work. Verify the fingerprint in a terminal."));
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText(/Host key verification failed for work/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Open Workspace" })).toBeNull();
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
    await waitFor(() => expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/project"));
    resolveHome("/home/wsl-user");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/project");
    expect(anchor.host.browseListDir).not.toHaveBeenCalledWith(expect.objectContaining({ path: "/home/wsl-user" }));
  });

  it("preserves user edits when SSH config discovery finishes late", async () => {
    let resolveConfig!: (value: { hosts: { alias: string; source: string }[]; warnings: string[] }) => void;
    anchor.host.listSshConfigHosts.mockImplementation(() => new Promise((resolve) => { resolveConfig = resolve; }));
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onOpen={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    await user.click(screen.getByRole("button", { name: "Manual connection" }));
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Change connection" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    resolveUse({ id: "ssh", kind: "ssh", profileId: "ssh-config-work" });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ path: "/", hostProfileId: "ssh-config-work", hostKind: "ssh" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows only the current step and uses a compact connected summary", async () => {
    const user = await showSsh();
    expect(screen.queryByLabelText("Remote folders")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Connected"));
    expect(screen.queryByLabelText("SSH config host")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open Workspace" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Choose a folder" }));
    await user.click(screen.getByRole("button", { name: "Change connection" }));
    expect((screen.getByLabelText("SSH config host") as HTMLInputElement).value).toBe("work");
    expect(document.activeElement).toBe(screen.getByLabelText("SSH config host"));
    expect(screen.queryByLabelText("Remote folders")).toBeNull();
  });

  it("connects by Enter and preserves verification guidance without a second CTA", async () => {
    const user = await showSsh();
    const summary = screen.getByRole("button", { name: "Authentication & security details" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/Unknown host keys must be verified/)).toBeTruthy();
    await user.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/SSH config may run local commands/)).toBeTruthy();
    await user.click(screen.getByLabelText("SSH config host"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Change connection" })).toBeTruthy());
  });

  it("keeps Cancel available while connecting and ignores the late response", async () => {
    let resolveBrowse!: (value: unknown[]) => void;
    anchor.host.browseListDir.mockImplementation(() => new Promise((resolve) => { resolveBrowse = resolve; }));
    const onClose = vi.fn();
    const onOpen = vi.fn();
    const user = await showSsh(onOpen, onClose);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Opening…" })).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    resolveBrowse([{ name: "late-folder", type: "dir" }]);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("late-folder")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("preserves the alias after a failed connection and allows retry", async () => {
    anchor.host.browseListDir.mockRejectedValueOnce(new Error("Host key verification failed"));
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Host key verification failed"));
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect((screen.getByLabelText("SSH config host") as HTMLInputElement).value).toBe("work");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Workspace" })).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requires a typed folder path to load successfully before opening it", async () => {
    const onOpen = vi.fn();
    const user = await showSsh(onOpen);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByLabelText("Folder path")).toBeTruthy());
    await user.clear(screen.getByLabelText("Folder path"));
    await user.type(screen.getByLabelText("Folder path"), "/home/tester/project");
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(anchor.host.browseListDir).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/home/tester/project" })));
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "/home/tester/project" }));
  });

  it("does not open an invalid or failed typed path", async () => {
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByLabelText("Folder path")).toBeTruthy());
    await user.clear(screen.getByLabelText("Folder path"));
    await user.type(screen.getByLabelText("Folder path"), "relative");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toContain("absolute folder path");
    expect(anchor.host.browseListDir).toHaveBeenCalledTimes(1);
    anchor.host.browseListDir.mockRejectedValueOnce(new Error("Permission denied"));
    await user.clear(screen.getByLabelText("Folder path"));
    await user.type(screen.getByLabelText("Folder path"), "/private");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Permission denied"));
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".workspace-dialog__footer-context strong")?.textContent).toBe("/");
  });

  it("allows an empty directory to be opened", async () => {
    anchor.host.browseListDir.mockResolvedValue([]);
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("No subfolders. You can open this folder.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Open Workspace" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps advanced manual SSH verification strict by default", async () => {
    const user = await showSsh();
    await user.click(screen.getByRole("button", { name: "Manual connection" }));
    const summary = screen.getByRole("button", { name: "Private key & host verification" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    await user.click(summary);
    const policy = screen.getByRole("combobox", { name: "Host key verification" });
    expect(policy.textContent).toContain("Strict: require a known host key");
    await user.click(policy);
    expect(screen.getByRole("option", { name: /Strict/ }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Host" }), "example.test");
    await user.type(screen.getByLabelText("Username"), "tester");
    await user.type(screen.getByLabelText("Private key path (optional)"), "/keys/work");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(anchor.host.upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ ssh: expect.objectContaining({ knownHostsPolicy: "strict", privateKeyPath: "/keys/work" }) })));
  });

  it("traps keyboard focus, closes with Escape and restores launcher focus", async () => {
    const user = userEvent.setup();
    const launcher = document.createElement("button");
    document.body.append(launcher);
    launcher.focus();
    const onClose = vi.fn();
    const view = render(<OpenWorkspaceDialog open onClose={onClose} onOpen={vi.fn()} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    const first = screen.getByRole("button", { name: "Close" });
    const last = screen.getByRole("button", { name: "Choose folder…" });
    first.focus();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<OpenWorkspaceDialog open={false} onClose={onClose} onOpen={vi.fn()} />);
    expect(document.activeElement).toBe(launcher);
    launcher.remove();
  });

  it("cannot Escape or Cancel during the active workspace commit", async () => {
    let resolveUse!: (value: unknown) => void;
    anchor.host.useProfile.mockImplementation(() => new Promise((resolve) => { resolveUse = resolve; }));
    const onClose = vi.fn();
    const user = await showSsh(vi.fn(), onClose);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Workspace" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    await user.keyboard("{Escape}");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    resolveUse({ id: "ssh", kind: "ssh" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("preserves input focus across parent rerenders with an inline close callback", async () => {
    const user = userEvent.setup();
    const view = render(<OpenWorkspaceDialog open onClose={() => {}} onOpen={vi.fn()} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    const input = screen.getByLabelText("SSH config host");
    input.focus();
    view.rerender(<OpenWorkspaceDialog open onClose={() => {}} onOpen={vi.fn()} />);
    expect(document.activeElement).toBe(input);
  });

});

// jsdom does not lay out elements or support min()/Electron CSS declarations.
// Protect the stylesheet contracts here; actual bounds and hit testing require
// rendered browser/Electron QA.

describe("recent workspaces", () => {
  let anchor: AnchorMock;

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    setWindowsUa(true);
    anchor = installAnchor();
    anchor.host.listProfiles.mockResolvedValue([
      { id: "local-default", kind: "local" as const, label: "Local" },
      { id: "wsl-default", kind: "wsl" as const, label: "WSL (Ubuntu)", wsl: { distro: "Ubuntu" } },
      { id: "ssh-config-pyoneer3", kind: "ssh" as const, label: "pyoneer3", ssh: { configHost: "pyoneer3" } },
    ]);
    anchor.workspace.getRecent.mockResolvedValue([
      { path: "/data/miles/pyoneer3", hostProfileId: "ssh-config-pyoneer3", lastOpenedAt: "2026-10-27T10:00:00.000Z" },
      { path: "/home/miles/app", hostProfileId: "wsl-default", lastOpenedAt: "2026-10-26T10:00:00.000Z" },
      { path: "/tmp/local-proj", hostProfileId: "local-default", lastOpenedAt: "2026-10-25T10:00:00.000Z" },
    ]);
  });

  it("hides the page switcher and shows New when there are no entries", async () => {
    anchor.workspace.getRecent.mockResolvedValue([]);
    render(<OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(anchor.workspace.getRecent).toHaveBeenCalled());
    expect(screen.queryByRole("radiogroup", { name: "Open workspace page" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recent workspaces" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Local" })).toBeTruthy());
  });

  it("lists recent workspaces with host icons and opens one on click", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onClose={onClose} onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Recent workspaces" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "Recent" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" })).toBeTruthy();
    expect(screen.getByText("/data/miles/pyoneer3 · pyoneer3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open app (WSL (Ubuntu))" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open local-proj (Local)" })).toBeTruthy();
    // Recent page: Cancel only in footer
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose folder…" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" }));
    await waitFor(() => expect(anchor.host.useProfile).toHaveBeenCalledWith("ssh-config-pyoneer3"));
    expect(anchor.workspace.listDir).toHaveBeenCalledWith("/data/miles/pyoneer3");
    expect(onOpen).toHaveBeenCalledWith({
      path: "/data/miles/pyoneer3",
      hostProfileId: "ssh-config-pyoneer3",
      hostKind: "ssh",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the entry and shows an inline error when a recent path is unreachable", async () => {
    anchor.workspace.listDir.mockRejectedValueOnce(new Error("Cannot list directory: /data/miles/pyoneer3"));
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onClose={onClose} onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cannot list directory"));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" })).toBeTruthy();
  });

  it("removes a recent entry from the list", async () => {
    anchor.workspace.removeRecent.mockResolvedValue([
      { path: "/home/miles/app", hostProfileId: "wsl-default", lastOpenedAt: "2026-10-26T10:00:00.000Z" },
      { path: "/tmp/local-proj", hostProfileId: "local-default", lastOpenedAt: "2026-10-25T10:00:00.000Z" },
    ]);
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Remove pyoneer3 from recent" }));
    await waitFor(() => expect(anchor.workspace.removeRecent).toHaveBeenCalledWith({
      path: "/data/miles/pyoneer3",
      hostProfileId: "ssh-config-pyoneer3",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open pyoneer3 (pyoneer3)" })).toBeNull());
    expect(screen.getByRole("button", { name: "Open app (WSL (Ubuntu))" })).toBeTruthy();
  });

  it("switches between Recent and New pages", async () => {
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Recent workspaces" })).toBeTruthy());
    await user.click(screen.getByRole("radio", { name: "New" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Local" })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Recent workspaces" })).toBeNull();
    expect(screen.getByRole("radio", { name: "New" }).getAttribute("aria-checked")).toBe("true");
    // Windows default host is WSL → Open Workspace; Local would show Choose folder…
    expect(screen.getByRole("button", { name: "Open Workspace" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Recent workspaces" })).toBeTruthy());
  });

  it("lists every recent entry without a Show all cap", async () => {
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    anchor.workspace.getRecent.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        path: `/tmp/proj-${i}`,
        hostProfileId: "local-default",
        lastOpenedAt: new Date(now - i * 3600000).toISOString(),
      })),
    );
    render(<OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Recent workspaces" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Open proj-0 (Local)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open proj-5 (Local)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("switches to New after removing the last recent entry", async () => {
    anchor.workspace.getRecent.mockResolvedValue([
      { path: "/data/miles/pyoneer3", hostProfileId: "ssh-config-pyoneer3", lastOpenedAt: "2026-10-27T10:00:00.000Z" },
    ]);
    anchor.workspace.removeRecent.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onClose={() => {}} onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open pyoneer3 (pyoneer3)" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Remove pyoneer3 from recent" }));
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Open workspace page" })).toBeNull());
    expect(screen.getByRole("radio", { name: "Local" })).toBeTruthy();
  });
});

describe("workspace dialog layout contracts", () => {
  const dialogCss = readFileSync("src/features/workspace/OpenWorkspaceDialog.css", "utf8").replace(/\r\n/g, "\n");

  function styleFor(selector: string, css = dialogCss.split("@media")[0]): Record<string, string> {
    const rules = Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g));
    const matches = rules.filter((rule) => rule[1].trim() === selector || rule[1].split(",").some((part) => part.trim() === selector));
    expect(matches.length, `Missing CSS rule: ${selector}`).toBeGreaterThan(0);
    const body = matches.map((rule) => rule[2]).join(";");
    return Object.fromEntries(body.split(";").filter((declaration) => declaration.includes(":")).map((declaration) => {
      const colon = declaration.indexOf(":");
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
    }));
  }

  it("lets the host cards size the segmented control instead of the 18px toolbar pill", () => {
    const seg = dialogCss.slice(dialogCss.indexOf("/* Host kind segmented control"));
    const hostChoice = styleFor(".workspace-dialog .host-choice.anchor-seg", seg);
    expect(hostChoice.height).toBe("auto");
    expect(hostChoice["margin-left"]).toBe("0");
    expect(hostChoice.display).toBe("grid");
    const card = styleFor(".workspace-dialog .host-choice.anchor-seg .repo-seg__btn", seg);
    expect(card["min-height"]).toBe("52px");
    expect(card.height).toBe("auto");
    // Content after the cards must flow in normal layout, never overlay them.
    expect(styleFor(".workspace-dialog__content > *")["flex-shrink"]).toBe("0");
    expect(dialogCss).not.toMatch(/margin-top:\s*-/);
    expect(dialogCss).not.toMatch(/position:\s*absolute;[^}]*\.workspace-dialog__(folder|connected)/);
  });

  it("renders the connected SSH summary and folder section as siblings after the host cards", async () => {
    setWindowsUa(false);
    const anchor = installAnchor();
    anchor.host.listSshConfigHosts.mockResolvedValue({ hosts: [{ alias: "devsrv", source: "~/.ssh/config" }], warnings: [] });
    anchor.host.browseListDir.mockResolvedValue([{ name: "home", type: "dir" }]);
    const user = userEvent.setup();
    render(<OpenWorkspaceDialog open onOpen={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(anchor.host.listSshConfigHosts).toHaveBeenCalled());
    await user.click(screen.getByRole("radio", { name: "SSH" }));
    await waitFor(() => expect((screen.getByLabelText("SSH config host") as HTMLInputElement).value).toBe("devsrv"));
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByText("home")).toBeTruthy());
    const content = document.querySelector(".workspace-dialog__content")!;
    const children = Array.from(content.children).map((el) => el.className.split(" ").find((c) => c.startsWith("host-choice") || c.startsWith("workspace-dialog__")) ?? el.className);
    const hostIdx = children.indexOf("host-choice");
    expect(hostIdx).toBeGreaterThanOrEqual(0);
    expect(children.slice(hostIdx, hostIdx + 3)).toEqual(["host-choice", "workspace-dialog__connected", "workspace-dialog__folder"]);
    cleanup();
  });

  it("reserves a viewport-bounded outer height instead of resizing to loaded content", () => {
    const modal = styleFor(".modal.workspace-dialog");
    expect(modal.width).toBe("min(520px, calc(100vw - 32px))");
    expect(modal.height).toBe("min(580px, calc(100dvh - 48px))");
    expect(modal.overflow).toBe("hidden");
    const narrow = dialogCss.slice(dialogCss.indexOf("@media (max-width: 520px)"));
    expect(styleFor(".modal.workspace-dialog", narrow).height).toBe("min(580px, calc(100dvh - 24px))");
  });

  it("scrolls long forms and folder lists inside the fixed dialog", () => {
    const content = styleFor(".workspace-dialog__content");
    expect(content.flex).toBe("1");
    expect(content["min-height"]).toBe("0");
    expect(content.overflow).toBe("auto");
    const list = styleFor(".workspace-dialog .wsl-browser__list");
    expect(list.flex).toBe("1");
    expect(list["min-height"]).toBe("0");
    expect(list.overflow).toBe("auto");
    expect(styleFor(".workspace-dialog__folder").flex).toBe("1");
    expect(styleFor(".workspace-dialog .wsl-browser").flex).toBe("1");
    expect(styleFor(".workspace-dialog .modal__header").flex).toBe("0 0 auto");
    expect(styleFor(".workspace-dialog__footer.modal__footer").flex).toBe("0 0 auto");
  });

  it("keeps the modal out of Electron drag regions and reserves the close hit target", () => {
    const noDrag = styleFor(".workspace-dialog-backdrop,\n.workspace-dialog,\n.workspace-dialog *");
    expect(noDrag["-webkit-app-region"]).toBe("no-drag");
    expect(styleFor(".workspace-dialog__close").flex).toBe("0 0 30px");
    expect(styleFor(".workspace-dialog__close > .codicon")["pointer-events"]).toBe("none");
  });

  it("keeps advanced fields at the normal input size and removes decorative step styling", () => {
    expect(styleFor(".workspace-dialog__advanced-fields")["font-size"]).toBe("13px");
    expect(styleFor(".workspace-dialog__advanced-fields")["font-family"]).toBeUndefined();
    expect(dialogCss).not.toContain("workspace-dialog__steps");
  });


  it("uses the themed Combobox for SSH config hosts instead of a native datalist", () => {
    const dialogTsx = readFileSync("src/features/workspace/OpenWorkspaceDialog.tsx", "utf8");
    expect(dialogTsx).toContain('from "@/shared/Combobox"');
    expect(dialogTsx).toContain("<Combobox");
    expect(dialogTsx).not.toContain("<datalist");
    expect(dialogTsx).not.toMatch(/list=["']ssh-config-hosts["']/);
  });

  it("gives the secondary connection controls smaller text with comfortable padding", () => {
    for (const selector of [".workspace-dialog__modes > .btn", ".workspace-dialog__connected > .btn"]) {
      const button = styleFor(selector);
      expect(button["font-size"]).toBe("11px");
      expect(button["font-weight"]).toBe("400");
      expect(button.height).toBe("28px");
      expect(button.padding).toBe("0 10px");
      expect(button["font-family"]).toBeUndefined();
      expect(button.color).toBeUndefined();
      expect(button.opacity).toBeUndefined();
    }
  });
});
