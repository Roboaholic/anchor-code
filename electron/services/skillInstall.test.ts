import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  getSkillInstallStatus,
  installSkill,
  installSkillToWorkspace,
  isWorkspaceSkillInstalled,
  readBundledSkillText,
  resolveBundledSkillPath,
  workspaceSkillFile,
} from "./skillInstall.js";

describe("skillInstall", () => {
  let root: string;
  let host: LocalHostSession;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let fakeHome: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-skill-ws-"));
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-skill-home-"));
    host = new LocalHostSession("skill-test");
    host.workspaceRoot = root;

    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  it("resolves bundled SKILL.md from the repo", () => {
    const p = resolveBundledSkillPath();
    expect(p, "skills/anchor-review/SKILL.md should ship in repo").toBeTruthy();
    const bundled = readBundledSkillText();
    expect(bundled.text).toContain("name: anchor-review");
    expect(bundled.text).toContain("need_modify");
    expect(bundled.text).toContain(".anchor-code");
  });

  it("installs skill into workspace .agents/skills", async () => {
    expect(await isWorkspaceSkillInstalled(host, root)).toBe(false);

    const result = await installSkillToWorkspace(host, root);
    expect(result.ok).toBe(true);
    expect(result.installed.some((i) => i.id === "workspace")).toBe(true);
    expect(await isWorkspaceSkillInstalled(host, root)).toBe(true);

    const skillPath = workspaceSkillFile(host, root);
    const text = await fs.readFile(skillPath, "utf8");
    expect(text).toContain("Anchor Review (Anchor Code)");
  });

  it("errors when .agents is a file, without deleting it", async () => {
    const placeholder = path.join(root, ".agents");
    await fs.writeFile(placeholder, "keep me\n");
    const result = await installSkillToWorkspace(host, root);
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/is a file, not a directory/);
    // Must not delete or rewrite the placeholder.
    expect(await fs.readFile(placeholder, "utf8")).toBe("keep me\n");
    const st = await fs.stat(placeholder);
    expect(st.isFile()).toBe(true);
    // Must not install under a fallback path either.
    await expect(
      fs.access(
        path.join(root, ".anchor-code", "skills", "anchor-review", "SKILL.md"),
      ),
    ).rejects.toBeTruthy();
  });

  it("offers codex user target when ~/.codex exists and installs there", async () => {
    await fs.mkdir(path.join(fakeHome, ".codex", "skills"), {
      recursive: true,
    });

    const status = await getSkillInstallStatus(host, root);
    const ids = status.targets.map((t) => t.id);
    expect(ids).toContain("workspace");
    expect(ids).toContain("codex");

    const result = await installSkill(host, {
      workspaceRoot: root,
      targetIds: ["codex"],
    });
    expect(result.ok).toBe(true);
    const codexPath = path.join(
      fakeHome,
      ".codex",
      "skills",
      "anchor-review",
      "SKILL.md",
    );
    const text = await fs.readFile(codexPath, "utf8");
    expect(text).toContain("name: anchor-review");

    const after = await getSkillInstallStatus(host, root);
    const codex = after.targets.find((t) => t.id === "codex");
    expect(codex?.installed).toBe(true);
    expect(codex?.upToDate).toBe(true);
  });
});
