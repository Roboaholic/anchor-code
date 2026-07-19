import { app, BrowserWindow, Menu } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalHostSession } from "./host/localHost.js";
import { registerIpc } from "./ipc/register.js";
import { TerminalService } from "./services/terminalService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DIST_ELECTRON = path.join(__dirname);
process.env.DIST = path.join(__dirname, "../dist");
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? path.join(__dirname, "../public")
  : process.env.DIST;

let mainWindow: BrowserWindow | null = null;

const host = new LocalHostSession();
const terminal = new TerminalService(() => mainWindow);

/**
 * Preload must load as CommonJS when package.json has "type":"module".
 * A .mjs file that still uses require() fails silently → no window.anchor.
 */
function resolvePreloadPath(): string {
  const candidates = [
    path.join(__dirname, "preload.cjs"),
    path.join(__dirname, "preload.js"),
    path.join(__dirname, "preload.mjs"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  console.error("[main] preload not found, tried:", candidates.join(", "));
  return candidates[0]!;
}

function createWindow() {
  const preloadPath = resolvePreloadPath();
  console.log("[main] using preload:", preloadPath);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Anchor Code",
    backgroundColor: "#f7f7f8",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

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
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace…",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            mainWindow?.webContents.send("shell:command", {
              type: "openWorkspace",
            });
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerIpc({
    host,
    getMainWindow: () => mainWindow,
    appVersion: app.getVersion(),
    terminal,
  });
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  terminal.disposeAll();
  void host.dispose();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
