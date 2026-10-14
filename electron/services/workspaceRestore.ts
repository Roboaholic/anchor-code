/**
 * Startup restore of the last active workspace.
 *
 * The renderer asks for a restore target once on launch. We only return a
 * target after a bounded reachability probe (path exists on its host), so an
 * unplugged drive, a stopped WSL distro or an unreachable SSH host falls back
 * to the Welcome page instead of hanging startup.
 */
import type { HostProfile } from "../settings.js";
import type { WorkspaceInstancesState } from "./workspaceState.js";

export const RESTORE_PROBE_TIMEOUT_MS = 6_000;

export interface RestoreTarget {
  path: string;
  hostProfileId: string;
}

export interface RestoreDeps {
  enabled: () => Promise<boolean>;
  loadInstances: () => Promise<WorkspaceInstancesState>;
  getHostProfile: (id: string) => Promise<HostProfile | null>;
  /** Resolve true when `path` is an existing directory on the profile's host. */
  probe: (profile: HostProfile, path: string) => Promise<boolean>;
  timeoutMs?: number;
  log?: (message: string) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function resolveRestoreTarget(deps: RestoreDeps): Promise<RestoreTarget | null> {
  const log = deps.log ?? (() => undefined);
  try {
    if (!(await deps.enabled())) return null;
    const state = await deps.loadInstances();
    const active = state.openWorkspaces.find((item) => item.id === state.activeWorkspaceId);
    if (!active) return null;
    const profile = await deps.getHostProfile(active.hostProfileId);
    if (!profile) {
      log(`host profile missing: ${active.hostProfileId}`);
      return null;
    }
    const ok = await withTimeout(
      deps.probe(profile, active.root),
      deps.timeoutMs ?? RESTORE_PROBE_TIMEOUT_MS,
      false,
    );
    if (!ok) {
      log(`last workspace unreachable, showing Welcome: ${active.root}`);
      return null;
    }
    return { path: active.root, hostProfileId: active.hostProfileId };
  } catch (err) {
    log(`restore target failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
