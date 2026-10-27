import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const handlers = new Map<string, Handler>();

const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  logger: null as unknown,
  setFeedURL: vi.fn(),
  on: vi.fn((event: string, cb: Handler) => {
    handlers.set(event, cb);
  }),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
};

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.69",
    isPackaged: true,
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  session: {
    defaultSession: { flushStorageData: vi.fn() },
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
  },
}));

vi.mock("electron-updater", () => ({
  default: { autoUpdater },
}));

describe("appUpdate download readiness", () => {
  beforeEach(() => {
    handlers.clear();
    vi.resetModules();
    autoUpdater.checkForUpdates.mockReset();
    autoUpdater.downloadUpdate.mockReset();
    autoUpdater.on.mockClear();
    autoUpdater.setFeedURL.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function load() {
    return import("./appUpdate.js");
  }

  it("check-then-downloads when available state came without updater metadata", async () => {
    const mod = await load();
    mod.initAppUpdater({ getMainWindow: () => null });

    // Simulate GitHub-API-style "available" without update-available event:
    // download must refresh via electron-updater first.
    expect(mod.isUpdaterReadyToDownload()).toBe(false);

    autoUpdater.checkForUpdates.mockImplementation(async () => {
      handlers.get("update-available")?.({ version: "0.1.70" });
      return { isUpdateAvailable: true, updateInfo: { version: "0.1.70" } };
    });
    autoUpdater.downloadUpdate.mockResolvedValue(["/tmp/update.exe"]);

    // Seed UI-visible available state the way GitHub fallback would.
    // We only care that download path refreshes updater before downloadUpdate.
    const state = await mod.downloadAppUpdate();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled();
    expect(mod.isUpdaterReadyToDownload()).toBe(true);
    expect(state.status === "downloading" || state.status === "downloaded" || state.status === "available").toBe(
      true,
    );
  });

  it("downloads directly when updater already reported update-available", async () => {
    const mod = await load();
    mod.initAppUpdater({ getMainWindow: () => null });

    handlers.get("update-available")?.({ version: "0.1.70" });
    expect(mod.isUpdaterReadyToDownload()).toBe(true);

    autoUpdater.downloadUpdate.mockResolvedValue(["/tmp/update.exe"]);

    await mod.downloadAppUpdate();

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalled();
  });

  it("retries once when downloadUpdate says check first", async () => {
    const mod = await load();
    mod.initAppUpdater({ getMainWindow: () => null });

    // Pretend we think we're ready, but updater disagrees on first download.
    handlers.get("update-available")?.({ version: "0.1.70" });
    expect(mod.isUpdaterReadyToDownload()).toBe(true);

    autoUpdater.downloadUpdate
      .mockRejectedValueOnce(new Error("Please check update first"))
      .mockResolvedValueOnce(["/tmp/update.exe"]);

    autoUpdater.checkForUpdates.mockImplementation(async () => {
      handlers.get("update-available")?.({ version: "0.1.70" });
      return { isUpdateAvailable: true, updateInfo: { version: "0.1.70" } };
    });

    const state = await mod.downloadAppUpdate();

    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(state.error).toBeNull();
  });
});
