// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog";

interface AnchorMock {
  host: {
    listProfiles: ReturnType<typeof vi.fn>;
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
  return (window as Window & { anchor: AnchorMock }).anchor;
}

function installAnchor(pickFolder?: ReturnType<typeof vi.fn>): AnchorMock {
  const anchor: AnchorMock = {
    host: {
      listProfiles: vi.fn(async () => [
        { id: "local-default", kind: "local" as const, label: "Local" },
        { id: "wsl-default", kind: "wsl" as const, label: "WSL" },
      ]),
      listWslDistros: vi.fn(async () => ["Ubuntu-24.04"]),
      wslHome: vi.fn(async () => "/home/miles"),
      browseListDir: vi.fn(async (args: { path: string }) => {
        if (args.path === "/home/miles") {
          return [
            { name: "repo-a", type: "dir" as const },
            { name: "repo-b", type: "dir" as const },
            { name: "readme.md", type: "file" as const },
            { name: ".config", type: "dir" as const },
          ];
        }
        if (args.path === "/home/miles/repo-a") {
          return [{ name: "src", type: "dir" as const }];
        }
        if (args.path === "/home") {
          return [{ name: "miles", type: "dir" as const }];
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
      ).toBe("/home/miles");
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
          expect.objectContaining({ path: "/home/miles/repo-a" }),
        );
      });
      await waitFor(() => expect(screen.getByText("src")).toBeTruthy());

      await user.click(screen.getByRole("button", { name: /up/i }));
      await waitFor(() => {
        expect(anchor.host.browseListDir).toHaveBeenCalledWith(
          expect.objectContaining({ path: "/home/miles" }),
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
          path: "/home/miles",
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
      anchor.workspace.pickFolder = vi.fn(async () => "C:\\Users\\miles\\proj");
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
          path: "C:\\Users\\miles\\proj",
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
