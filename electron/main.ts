import { app, BrowserWindow, ipcMain, Menu } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostManager } from "./host/hostManager.js";
import { registerIpc } from "./ipc/register.js";
import { TerminalService } from "./services/terminalService.js";
import { FileWatcherService } from "./services/fileWatcherService.js";
import { getRemoteAccessConfig, getUiTheme, type UiTheme } from "./settings.js";
import { initAppUpdater } from "./services/appUpdate.js";
import { AnchorApplication } from "./application/anchorApplication.js";
import { RemoteRequestHandler } from "./application/remoteRequestHandler.js";
import { RelayConnector } from "./remote/relayConnector.js";
import { registerRuntimeLifecycle } from "./application/runtimeLifecycle.js";
import {
  shellBackground,
  titleBarOverlayFor,
} from "./windowChrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DIST_ELECTRON = path.join(__dirname);
process.env.DIST = path.join(__dirname, "../dist");
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(__dirname, "../public")
  : process.env.DIST;

let mainWindow: BrowserWindow | null = null;
let agentInputFocused = false;
ipcMain.on("shell:setAgentInputFocused", (_event, focused: boolean) => {
  agentInputFocused = Boolean(focused);
  mainWindow?.webContents.setIgnoreMenuShortcuts(agentInputFocused);
});

const hosts = new HostManager();
const terminal = new TerminalService(
  () => mainWindow,
  () => hosts.session,
);
const fileWatcher = new FileWatcherService(
  () => mainWindow,
  () => hosts.session,
);
const application = new AnchorApplication({
  hosts,
  terminal,
});
application.subscribe((event) => {
  if (event.type === "workspace") {
    fileWatcher.stop();
    if (event.source === "remote") {
      mainWindow?.webContents.send("shell:command", {
        type: "workspaceChanged",
        path: event.workspace.path,
        hostProfileId: event.workspace.hostProfileId,
      });
    }
  }
});
const remoteHandler = new RemoteRequestHandler({
  application,
  appVersion: app.getVersion(),
});
const relay = new RelayConnector(remoteHandler);

/**
 * Preload must load as CommonJS when package.json has "type":"module".
 * A .mjs file that still uses require() fails silently → no window.anchor.
 */
function resolvePreloadPath(): string {
  const candidates = [
    path.join(__dirname, "preload.cjs"),
    path.join(__dirname, "preload.js"),
    path.join(__dirname, "../dist-electron/preload.cjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  console.error("[main] preload not found, tried:", candidates.join(", "));
  return candidates[0]!;
}

function createWindow(theme: UiTheme) {
  const preloadPath = resolvePreloadPath();
  console.log("[main] using preload:", preloadPath);

  const isMac = process.platform === "darwin";

  const iconPath = path.join(
    process.env.VITE_PUBLIC || path.join(__dirname, "../public"),
    process.platform === "win32" ? "favicon.ico" : "icon-512.png",
  );
  // Prefer packaged build icons when present
  const buildIcon =
    process.platform === "win32"
      ? path.join(__dirname, "../build/icon.ico")
      : path.join(__dirname, "../build/icon.png");
  const resolvedIcon = fs.existsSync(buildIcon)
    ? buildIcon
    : fs.existsSync(iconPath)
      ? iconPath
      : undefined;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Anchor Code",
    ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    backgroundColor: shellBackground(theme),
    // Single chrome row: no OS title strip + separate menu row.
    // macOS: traffic lights inset into the topbar; Windows: overlay caption buttons.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...(isMac
      ? {}
      : {
          titleBarOverlay: titleBarOverlayFor(theme),
        }),
    // Keep accelerators (Ctrl+P etc.) via application menu, but never paint
    // a second File/View/Window row under the title bar.
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const createdWindow = mainWindow;
  createdWindow.webContents.on("before-input-event", (event, input) => {
    if (agentInputFocused) return;
    const modifier = input.control || input.meta;
    if (!modifier || input.alt) return;
    const key = input.key;
    const command =
      key === "+" || key === "=" || key === "Add"
        ? "increaseFontSize"
        : key === "-" || key === "_" || key === "Subtract"
          ? "decreaseFontSize"
          : key === "0"
            ? "resetFontSize"
            : null;
    if (!command) return;
    event.preventDefault();
    createdWindow.webContents.send("shell:command", { type: command });
  });

  // Windows still attaches a native menu for roles/accelerators; hide the bar.
  if (!isMac) {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.webContents.on("preload-error", (_event, failedPath, error) => {
    console.error("[main] preload-error:", failedPath, error);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(process.env.DIST!, "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            mainWindow?.webContents.send("shell:command", {
              type: "openWorkspace",
            });
          },
        },
        {
          label: "Go to File…",
          accelerator: "CmdOrCtrl+P",
          click: () => {
            mainWindow?.webContents.send("shell:command", {
              type: "quickOpen",
            });
          },
        },
        {
          label: "Open File…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            mainWindow?.webContents.send("shell:command", {
              type: "openFilePath",
            });
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Actual Font Size",
          accelerator: "CmdOrCtrl+0",
          click: () => mainWindow?.webContents.send("shell:command", { type: "resetFontSize" }),
        },
        {
          label: "Increase Font Size",
          accelerator: "CmdOrCtrl+=",
          click: () => mainWindow?.webContents.send("shell:command", { type: "increaseFontSize" }),
        },
        {
          label: "Decrease Font Size",
          accelerator: "CmdOrCtrl+-",
          click: () => mainWindow?.webContents.send("shell:command", { type: "decreaseFontSize" }),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  const automatedWorkspace = process.env.ANCHOR_REMOTE_WORKSPACE?.trim();
  if (automatedWorkspace) {
    hosts.session.workspaceRoot = automatedWorkspace;
  }
  registerIpc({
    hosts,
    getMainWindow: () => mainWindow,
    appVersion: app.getVersion(),
    terminal,
    fileWatcher,
    application,
    relay,
  });
  const remoteConfig = await getRemoteAccessConfig();
  relay.start(remoteConfig.relay!);
  initAppUpdater({ getMainWindow: () => mainWindow });
  buildMenu();
  const theme = await getUiTheme().catch(() => "dark-modern" as UiTheme);
  createWindow(theme);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void getUiTheme()
        .catch(() => "dark-modern" as UiTheme)
        .then((t) => createWindow(t));
    }
  });
});

registerRuntimeLifecycle({
  app,
  platform: process.platform,
  quit: () => app.quit(),
  dispose: () => {
    terminal.disposeAll();
    fileWatcher.disposeAll();
    relay.stop();
    remoteHandler.dispose();
    void hosts.dispose();
  },
});
