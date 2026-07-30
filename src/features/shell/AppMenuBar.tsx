import { useEffect, useRef, useState } from "react";
import { Icon } from "@/shared/Icon";
import { useShellStore } from "./shellStore";

type MenuId = "file" | "view" | "window";

type MenuItem =
  | {
      kind: "action";
      label: string;
      accelerator?: string;
      action: string;
    }
  | { kind: "separator" };

const MENUS: Array<{ id: MenuId; label: string; items: MenuItem[] }> = [
  {
    id: "file",
    label: "File",
    items: [
      {
        kind: "action",
        label: "Open Workspace…",
        accelerator: "Ctrl+Shift+O",
        action: "openWorkspace",
      },
      {
        kind: "action",
        label: "Go to File…",
        accelerator: "Ctrl+P",
        action: "quickOpen",
      },
      {
        kind: "action",
        label: "Open File…",
        accelerator: "Ctrl+O",
        action: "openFilePath",
      },
      { kind: "separator" },
      { kind: "action", label: "Quit", accelerator: "Alt+F4", action: "quit" },
    ],
  },
  {
    id: "view",
    label: "View",
    items: [
      { kind: "action", label: "Reload", accelerator: "Ctrl+R", action: "reload" },
      {
        kind: "action",
        label: "Force Reload",
        accelerator: "Ctrl+Shift+R",
        action: "forceReload",
      },
      {
        kind: "action",
        label: "Toggle Developer Tools",
        accelerator: "Ctrl+Shift+I",
        action: "toggleDevTools",
      },
      { kind: "separator" },
      {
        kind: "action",
        label: "Actual Size",
        accelerator: "Ctrl+0",
        action: "resetZoom",
      },
      {
        kind: "action",
        label: "Zoom In",
        accelerator: "Ctrl+=",
        action: "zoomIn",
      },
      {
        kind: "action",
        label: "Zoom Out",
        accelerator: "Ctrl+-",
        action: "zoomOut",
      },
      { kind: "separator" },
      {
        kind: "action",
        label: "Toggle Full Screen",
        accelerator: "F11",
        action: "toggleFullscreen",
      },
    ],
  },
  {
    id: "window",
    label: "Window",
    items: [
      {
        kind: "action",
        label: "Minimize",
        accelerator: "Ctrl+M",
        action: "minimize",
      },
      { kind: "action", label: "Zoom", action: "zoom" },
      { kind: "separator" },
      { kind: "action", label: "Close", accelerator: "Ctrl+W", action: "close" },
    ],
  },
];

async function runMenuAction(action: string): Promise<void> {
  if (window.anchor?.shell?.menuAction) {
    await window.anchor.shell.menuAction(action);
    return;
  }
  if (
    action === "openWorkspace" ||
    action === "quickOpen" ||
    action === "openFilePath"
  ) {
    window.dispatchEvent(
      new CustomEvent("anchor:shell-command", { detail: { type: action } }),
    );
  }
}

export function AppMenuBar() {
  const [openId, setOpenId] = useState<MenuId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleLeft = useShellStore((s) => s.toggleLeft);
  const leftVisible = useShellStore((s) => s.leftVisible);
  // macOS renders the native app menu bar at the top of the screen; showing the
  // in-window File/View/Window menus here would duplicate it (and the duplicate
  // has click/timing issues). Hide the menus on macOS but keep the rail toggle.
  const isMac =
    document.documentElement.dataset.platform === "darwin";

  useEffect(() => {
    if (!openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    const onPointer = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        setOpenId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [openId]);

  return (
    <div
      className="app-menubar"
      ref={rootRef}
      role="menubar"
      aria-label="Application"
    >
      <button
        type="button"
        className={`btn btn--ghost btn--icon app-menubar__rail${leftVisible ? " is-active" : ""}`}
        onClick={toggleLeft}
        aria-pressed={leftVisible}
        aria-label="Toggle left sidebar"
        title="Toggle left sidebar"
      >
        <Icon name="layout-sidebar-left" className="btn__icon" />
      </button>
      {isMac
        ? null
        : MENUS.map((menu) => {
            const open = openId === menu.id;
            return (
          <div key={menu.id} className="app-menubar__item">
            <button
              type="button"
              className={`app-menubar__btn${open ? " is-open" : ""}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : menu.id)}
              onMouseEnter={() => {
                if (openId) setOpenId(menu.id);
              }}
            >
              {menu.label}
            </button>
            {open ? (
              <div className="app-menubar__menu" role="menu">
                {menu.items.map((item, idx) => {
                  if (item.kind === "separator") {
                    return (
                      <div
                        key={`sep-${menu.id}-${idx}`}
                        className="app-menubar__sep"
                        role="separator"
                      />
                    );
                  }
                  return (
                    <button
                      key={item.action}
                      type="button"
                      className="app-menubar__entry"
                      role="menuitem"
                      onClick={() => {
                        setOpenId(null);
                        void runMenuAction(item.action);
                      }}
                    >
                      <span className="app-menubar__entry-label">
                        {item.label}
                      </span>
                      {item.accelerator ? (
                        <span className="app-menubar__entry-accel">
                          {item.accelerator}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
          })}
      <div className="app-menubar__drag" aria-hidden />
    </div>
  );
}
