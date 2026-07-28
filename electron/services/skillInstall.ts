/**
 * Install the bundled Anchor Review agent skill into workspace and/or
 * user agent skill directories on the active HostSession.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostJoin } from "../host/paths.js";
import type { HostSession } from "../host/types.js";
import { HostError } from "../host/types.js";

export const SKILL_ID = "anchor-review";
export const SKILL_FILE = "SKILL.md";

export type SkillInstallTargetKind = "workspace" | "user";

export interface SkillInstallTarget {
  id: string;
  kind: SkillInstallTargetKind;
  /** Display label for Settings UI. */
  label: string;
  /** Directory that should contain SKILL.md (…/skills/anchor-review). */
  dir: string;
  /** Full path to SKILL.md on the host. */
  skillPath: string;
  installed: boolean;
  /** true when content matches the bundled skill. */
  upToDate: boolean;
}

export interface SkillInstallStatus {
  skillId: string;
  sourcePath: string | null;
  sourceVersionHint: string | null;
  targets: SkillInstallTarget[];
  workspaceRoot: string | null;
}

export interface SkillInstallResult {
  ok: boolean;
  installed: Array<{ id: string; skillPath: string }>;
  skipped: Array<{ id: string; reason: string }>;
  error?: string;
}

type UserSkillSpec = {
  id: string;
  label: string;
  /** Segments under $HOME, e.g. [".codex", "skills", "anchor-review"]. */
  segments: string[];
};

const USER_SKILL_SPECS: UserSkillSpec[] = [
  {
    id: "codex",
    label: "Codex (~/.codex/skills)",
    segments: [".codex", "skills", SKILL_ID],
  },
  {
    id: "claude",
    label: "Claude (~/.claude/skills)",
    segments: [".claude", "skills", SKILL_ID],
  },
  {
    id: "agents",
    label: "Agents (~/.agents/skills)",
    segments: [".agents", "skills", SKILL_ID],
  },
  {
    id: "grok",
    label: "Grok (~/.grok/skills)",
    segments: [".grok", "skills", SKILL_ID],
  },
  {
    id: "omp",
    label: "OMP (~/.omp/skills)",
    segments: [".omp", "skills", SKILL_ID],
  },
];

/** Resolve $HOME / %USERPROFILE% on the active host. */
export async function resolveHostHome(host: HostSession): Promise<string> {
  const cwd =
    host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  try {
    if (host.kind === "local" && process.platform === "win32") {
      const r = await host.run(cwd, "cmd.exe", [
        "/d",
        "/s",
        "/c",
        "echo %USERPROFILE%",
      ]);
      const line = r.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
      if (line) return line.trim();
    }
    const r = await host.run(cwd, "sh", ["-lc", 'printf %s "$HOME"']);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    // fall through
  }
  if (host.kind === "local") {
    return process.env.HOME || process.env.USERPROFILE || "";
  }
  return "/root";
}

/** Workspace skill always lives under `.agents/skills/<id>/`. */
const WORKSPACE_SKILL_SEGMENTS = [".agents", "skills", SKILL_ID] as const;

export function workspaceSkillDir(
  host: HostSession,
  workspaceRoot: string,
): string {
  return hostJoin(host.kind, workspaceRoot, ...WORKSPACE_SKILL_SEGMENTS);
}

export function workspaceSkillFile(
  host: HostSession,
  workspaceRoot: string,
): string {
  return hostJoin(
    host.kind,
    workspaceRoot,
    ...WORKSPACE_SKILL_SEGMENTS,
    SKILL_FILE,
  );
}

/**
 * Detect a blocking regular file named `.agents` (should be a directory).
 * Never delete or mutate it — caller surfaces a clear error.
 */
export async function workspaceAgentsBlocker(
  host: HostSession,
  workspaceRoot: string,
): Promise<string | null> {
  const agentsPath = hostJoin(host.kind, workspaceRoot, ".agents");
  try {
    if (!(await host.exists(agentsPath))) return null;
    const st = await host.stat(agentsPath);
    if (st.isDir) return null;
    if (st.isFile) {
      return (
        `${agentsPath} is a file, not a directory. ` +
        `Cannot install to .agents/skills/${SKILL_ID}/. ` +
        `Replace that file with a directory (manually) if you want workspace skill install.`
      );
    }
    return (
      `${agentsPath} exists but is not a directory. ` +
      `Cannot install to .agents/skills/${SKILL_ID}/.`
    );
  } catch {
    return null;
  }
}

/** Locate bundled SKILL.md for dev + packaged builds. */
export function resolveBundledSkillPath(): string | null {
  const candidates: string[] = [];

  try {
    if (app.isPackaged) {
      candidates.push(
        path.join(process.resourcesPath, "skills", SKILL_ID, SKILL_FILE),
      );
    }
  } catch {
    // app may be unavailable in pure unit tests
  }

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.resolve(here, "../../skills", SKILL_ID, SKILL_FILE),
      path.resolve(here, "../../../skills", SKILL_ID, SKILL_FILE),
    );
  } catch {
    // ignore
  }

  candidates.push(path.resolve(process.cwd(), "skills", SKILL_ID, SKILL_FILE));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // continue
    }
  }
  return null;
}

export function readBundledSkillText(): {
  path: string | null;
  text: string | null;
  versionHint: string | null;
} {
  const p = resolveBundledSkillPath();
  if (!p) return { path: null, text: null, versionHint: null };
  try {
    const text = fs.readFileSync(p, "utf8");
    const nameMatch = text.match(/^name:\s*(.+)$/m);
    return {
      path: p,
      text,
      versionHint: nameMatch?.[1]?.trim() || null,
    };
  } catch {
    return { path: p, text: null, versionHint: null };
  }
}

async function hostFileText(
  host: HostSession,
  filePath: string,
): Promise<string | null> {
  try {
    if (!(await host.exists(filePath))) return null;
    return await host.readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Offer a user target when the skill is already installed there, or the
 * agent home / skills parent already exists on the host.
 */
export async function shouldOfferUserTarget(
  host: HostSession,
  home: string,
  segments: string[],
): Promise<boolean> {
  const skillFile = hostJoin(host.kind, home, ...segments, SKILL_FILE);
  if (await host.exists(skillFile)) return true;

  // e.g. ~/.codex/skills
  if (segments.length >= 2) {
    const skillsParent = hostJoin(
      host.kind,
      home,
      ...segments.slice(0, segments.length - 1),
    );
    if (await host.exists(skillsParent)) return true;
  }
  // e.g. ~/.codex
  if (segments.length >= 1) {
    const agentRoot = hostJoin(host.kind, home, segments[0]!);
    if (await host.exists(agentRoot)) return true;
  }
  return false;
}

export async function getSkillInstallStatus(
  host: HostSession,
  workspaceRoot?: string | null,
): Promise<SkillInstallStatus> {
  const bundled = readBundledSkillText();
  const root =
    workspaceRoot?.trim() || host.workspaceRoot?.trim() || null;
  const targets: SkillInstallTarget[] = [];

  if (root) {
    const dir = workspaceSkillDir(host, root);
    const skillPath = workspaceSkillFile(host, root);
    const existing = await hostFileText(host, skillPath);
    targets.push({
      id: "workspace",
      kind: "workspace",
      label: "This workspace (.agents/skills)",
      dir,
      skillPath,
      installed: existing != null,
      upToDate:
        existing != null &&
        bundled.text != null &&
        existing === bundled.text,
    });
  }

  const home = await resolveHostHome(host);
  if (home) {
    for (const t of USER_SKILL_SPECS) {
      if (!(await shouldOfferUserTarget(host, home, t.segments))) continue;
      const dir = hostJoin(host.kind, home, ...t.segments);
      const skillPath = hostJoin(host.kind, home, ...t.segments, SKILL_FILE);
      const existing = await hostFileText(host, skillPath);
      targets.push({
        id: t.id,
        kind: "user",
        label: t.label,
        dir,
        skillPath,
        installed: existing != null,
        upToDate:
          existing != null &&
          bundled.text != null &&
          existing === bundled.text,
      });
    }
  }

  return {
    skillId: SKILL_ID,
    sourcePath: bundled.path,
    sourceVersionHint: bundled.versionHint,
    targets,
    workspaceRoot: root,
  };
}

export async function installSkill(
  host: HostSession,
  opts: {
    workspaceRoot?: string | null;
    /** Target ids from getSkillInstallStatus; empty = all offered targets. */
    targetIds?: string[];
  } = {},
): Promise<SkillInstallResult> {
  const bundled = readBundledSkillText();
  if (!bundled.text) {
    return {
      ok: false,
      installed: [],
      skipped: [],
      error:
        "Bundled skill not found. Expected skills/anchor-review/SKILL.md next to the app.",
    };
  }

  const status = await getSkillInstallStatus(host, opts.workspaceRoot);
  if (status.targets.length === 0) {
    return {
      ok: false,
      installed: [],
      skipped: [],
      error:
        "No install targets found. Open a workspace or ensure an agent skill home exists on this host.",
    };
  }

  const selected =
    opts.targetIds && opts.targetIds.length > 0
      ? opts.targetIds
      : status.targets.map((t) => t.id);
  const wanted: Record<string, true> = {};
  for (const id of selected) {
    const key = id.trim();
    if (key) wanted[key] = true;
  }

  const installed: SkillInstallResult["installed"] = [];
  const skipped: SkillInstallResult["skipped"] = [];

  for (const target of status.targets) {
    if (!wanted[target.id]) {
      skipped.push({ id: target.id, reason: "not selected" });
      continue;
    }
    try {
      if (target.id === "workspace") {
        const root =
          opts.workspaceRoot?.trim() ||
          host.workspaceRoot?.trim() ||
          null;
        if (root) {
          const blocker = await workspaceAgentsBlocker(host, root);
          if (blocker) {
            skipped.push({ id: target.id, reason: blocker });
            continue;
          }
        }
      }

      try {
        await host.mkdirp(target.dir);
      } catch {
        // writeFile may still create parents (e.g. WSL bash fallback).
      }
      await host.writeFile(target.skillPath, bundled.text);
      installed.push({
        id: target.id,
        skillPath: target.skillPath,
      });
    } catch (err) {
      skipped.push({
        id: target.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (installed.length === 0) {
    return {
      ok: false,
      installed,
      skipped,
      error:
        skipped.map((s) => `${s.id}: ${s.reason}`).join("; ") ||
        "Install failed",
    };
  }

  return { ok: true, installed, skipped };
}

/** Workspace-only install used by the open-workspace prompt. */
export async function installSkillToWorkspace(
  host: HostSession,
  workspaceRoot: string,
): Promise<SkillInstallResult> {
  const root = workspaceRoot.trim();
  if (!root) {
    throw new HostError("failed", "Workspace root required");
  }
  return installSkill(host, {
    workspaceRoot: root,
    targetIds: ["workspace"],
  });
}

export async function isWorkspaceSkillInstalled(
  host: HostSession,
  workspaceRoot: string,
): Promise<boolean> {
  const p = workspaceSkillFile(host, workspaceRoot);
  try {
    return await host.exists(p);
  } catch {
    return false;
  }
}
