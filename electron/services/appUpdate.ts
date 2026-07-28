/**
 * App updates from GitHub Releases (electron-builder publish config).
 *
 * Packaged builds: electron-updater (NSIS / dmg / AppImage).
 * Dev / unpackaged: GitHub API check + open release page (cannot self-install).
 */
import { app, shell, type BrowserWindow } from "electron";
// electron-updater is CJS — default import required under ESM main.
import electronUpdater from "electron-updater";
import type { UpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;

const GITHUB_OWNER = "Roboaholic";
const GITHUB_REPO = "anchor-code";
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  /** When true, quitAndInstall is available (packaged + downloaded). */
  canInstall: boolean;
  /** When true, check uses electron-updater; otherwise GitHub API only. */
  packaged: boolean;
  progress: number | null;
  message: string | null;
  error: string | null;
}

type Listener = (state: UpdateState) => void;

let state: UpdateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  latestVersion: null,
  releaseUrl: null,
  canInstall: false,
  packaged: app.isPackaged,
  progress: null,
  message: null,
  error: null,
};

const listeners = new Set<Listener>();
let wired = false;
let getMainWindow: (() => BrowserWindow | null) | null = null;
/** Periodic background check handle (packaged + dev). */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Default: 30 minutes between automatic checks. */
export const UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1000;

function emit() {
  const snapshot = { ...state };
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch {
      // ignore listener errors
    }
  }
  const win = getMainWindow?.();
  win?.webContents.send("app:updateState", snapshot);
}

function setState(partial: Partial<UpdateState>) {
  state = { ...state, ...partial, currentVersion: app.getVersion(), packaged: app.isPackaged };
  emit();
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function applyDevFeedFromEnv(): void {
  const url = (process.env.ANCHOR_UPDATE_URL || "").trim().replace(/\/+$/, "");
  if (!url) return;
  // Generic provider: serve a folder containing latest.yml + installers.
  // Example: ANCHOR_UPDATE_URL=http://127.0.0.1:4040  (folder has latest.yml)
  try {
    autoUpdater.setFeedURL({ provider: "generic", url });
    console.log("[appUpdate] using local feed:", url);
  } catch (err) {
    console.warn(
      "[appUpdate] setFeedURL failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function wireAutoUpdater() {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Local update demos: verbose logs help see check/download progress.
  if (process.env.ANCHOR_UPDATE_URL) {
    autoUpdater.logger = console;
  } else {
    autoUpdater.logger = null;
  }
  applyDevFeedFromEnv();

  autoUpdater.on("checking-for-update", () => {
    setState({
      status: "checking",
      message: "Checking for updates…",
      error: null,
      progress: null,
    });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    setState({
      status: "available",
      latestVersion: info.version,
      releaseUrl: `${RELEASES_URL}/tag/v${info.version}`,
      canInstall: false,
      message: `Version ${info.version} is available.`,
      error: null,
      progress: null,
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    setState({
      status: "not-available",
      latestVersion: info.version,
      releaseUrl: `${RELEASES_URL}/tag/v${info.version}`,
      canInstall: false,
      message: "You're on the latest version.",
      error: null,
      progress: null,
    });
  });

  autoUpdater.on("download-progress", (p) => {
    setState({
      status: "downloading",
      progress: Math.round(p.percent),
      message: `Downloading… ${Math.round(p.percent)}%`,
      error: null,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    setState({
      status: "downloaded",
      latestVersion: info.version,
      canInstall: true,
      progress: 100,
      message: `Version ${info.version} ready — restart to install.`,
      error: null,
    });
  });

  autoUpdater.on("error", (err) => {
    setState({
      status: "error",
      canInstall: false,
      progress: null,
      message: null,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function initAppUpdater(opts: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  getMainWindow = opts.getMainWindow;
  state = {
    ...state,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
  };
  // Packaged builds always wire updater. Dev can also wire when a local feed
  // is set so Settings → Updates can exercise check UI against a mock server.
  if (app.isPackaged || process.env.ANCHOR_UPDATE_URL) {
    wireAutoUpdater();
  }
  startUpdatePolling();
}

/**
 * Background check every UPDATE_POLL_INTERVAL_MS.
 * Quiet: network errors do not flip UI to a sticky error during poll.
 * First check is delayed slightly so window/IPC is ready.
 */
export function startUpdatePolling(
  intervalMs: number = UPDATE_POLL_INTERVAL_MS,
): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const tick = () => {
    void quietCheckForUpdates();
  };
  // Local feed demos: check almost immediately so the badge/button appears.
  // Packaged production: delay ~45s after launch.
  const delayMs = process.env.ANCHOR_UPDATE_URL?.trim() ? 2_000 : 45_000;
  const initial = setTimeout(tick, delayMs);
  // Unref so this doesn't keep the process alive on quit in edge cases.
  if (typeof (initial as NodeJS.Timeout).unref === "function") {
    (initial as NodeJS.Timeout).unref();
  }
  pollTimer = setInterval(tick, intervalMs);
  if (typeof (pollTimer as NodeJS.Timeout).unref === "function") {
    (pollTimer as NodeJS.Timeout).unref();
  }
}

/** Check without treating "already latest" / network blips as user-facing errors. */
async function quietCheckForUpdates(): Promise<void> {
  // Skip if user is already mid-download / ready to install.
  if (state.status === "downloading" || state.status === "downloaded") {
    return;
  }
  if (state.status === "checking") return;
  try {
    await checkForAppUpdates();
  } catch {
    // Quiet background poll — leave previous state alone.
  }
}

export function getUpdateState(): UpdateState {
  return { ...state, currentVersion: app.getVersion(), packaged: app.isPackaged };
}

export function onUpdateState(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function checkViaGithubApi(): Promise<UpdateState> {
  setState({
    status: "checking",
    message: "Checking GitHub Releases…",
    error: null,
    progress: null,
  });
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Anchor-Code/${app.getVersion()}`,
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    }
    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      name?: string;
    };
    const latest = (data.tag_name || "").replace(/^v/i, "");
    if (!latest) throw new Error("Latest release has no tag");
    const current = app.getVersion();
    const cmp = compareSemver(latest, current);
    if (cmp > 0) {
      setState({
        status: "available",
        latestVersion: latest,
        releaseUrl: data.html_url || `${RELEASES_URL}/tag/v${latest}`,
        canInstall: false,
        message: `Version ${latest} is available (dev / portable: open the release page to install).`,
        error: null,
      });
    } else {
      setState({
        status: "not-available",
        latestVersion: latest,
        releaseUrl: data.html_url || `${RELEASES_URL}/tag/v${latest}`,
        canInstall: false,
        message: "You're on the latest version.",
        error: null,
      });
    }
  } catch (err) {
    setState({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      message: null,
    });
  }
  return getUpdateState();
}

export async function checkForAppUpdates(): Promise<UpdateState> {
  // Full electron-updater path when packaged, or when a local feed is configured.
  const useUpdater = app.isPackaged || Boolean(process.env.ANCHOR_UPDATE_URL?.trim());
  if (!useUpdater) {
    return checkViaGithubApi();
  }
  wireAutoUpdater();
  try {
    setState({
      status: "checking",
      message: "Checking for updates…",
      error: null,
      progress: null,
    });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Network / missing latest.yml — fall back to GitHub API for messaging.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[appUpdate] electron-updater check failed:", msg);
    return checkViaGithubApi();
  }
  return getUpdateState();
}

export async function downloadAppUpdate(): Promise<UpdateState> {
  const useUpdater = app.isPackaged || Boolean(process.env.ANCHOR_UPDATE_URL?.trim());
  if (!useUpdater) {
    setState({
      status: "error",
      error:
        "In-app install only works in a packaged build. Open the release page to download.",
      message: null,
    });
    return getUpdateState();
  }
  wireAutoUpdater();
  try {
    setState({
      status: "downloading",
      progress: 0,
      message: "Starting download…",
      error: null,
    });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setState({
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      message: null,
      progress: null,
    });
  }
  return getUpdateState();
}

export function installAppUpdate(): { ok: boolean; error?: string } {
  const useUpdater = app.isPackaged || Boolean(process.env.ANCHOR_UPDATE_URL?.trim());
  if (!useUpdater) {
    return {
      ok: false,
      error: "Install only works in a packaged build.",
    };
  }
  if (state.status !== "downloaded") {
    return { ok: false, error: "No update downloaded yet." };
  }
  try {
    // isSilent=false, isForceRunAfter=true
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function openReleasePage(): Promise<{ ok: boolean }> {
  const url =
    state.releaseUrl ||
    (state.latestVersion
      ? `${RELEASES_URL}/tag/v${state.latestVersion}`
      : RELEASES_URL);
  await shell.openExternal(url);
  return { ok: true };
}
