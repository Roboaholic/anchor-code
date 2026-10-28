import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import { commitChanges, gitFailure } from "./historyService.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

describe("commitChanges surfaces git output", () => {
  let root: string;
  let home: string;
  let host: LocalHostSession;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-commit-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-home-"));
    host = new LocalHostSession("commit-err");
    host.workspaceRoot = root;
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@example.com"]);
    git(root, ["config", "user.name", "T"]);
    await fs.writeFile(path.join(root, "CMakeLists.txt"), "a\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "init"]);
    // Mirror the user's selection: M tracked, A staged, U untracked in a subdir.
    await fs.mkdir(path.join(root, "inc"));
    await fs.mkdir(path.join(root, "source_manager"));
    await fs.writeFile(path.join(root, "CMakeLists.txt"), "b\n");
    await fs.writeFile(path.join(root, "inc/source_manager.h"), "h\n");
    git(root, ["add", "inc/source_manager.h"]);
    await fs.writeFile(path.join(root, "source_manager/source_manager_internal.h"), "u\n");
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  const selection = [
    "CMakeLists.txt",
    "inc/source_manager.h",
    "source_manager/source_manager_internal.h",
  ];

  it("commits M + A + U selection with a Chinese multi-line message", async () => {
    const r = await commitChanges(host, root, "新增 source manager\n\n细节", selection);
    expect(r.subject).toBe("新增 source manager");
    const files = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: root, encoding: "utf8",
    });
    expect(files).toContain("source_manager/source_manager_internal.h");
  });

  it("includes git's identity error in the message when user.name/email is missing", async () => {
    git(root, ["config", "--unset", "user.email"]);
    git(root, ["config", "--unset", "user.name"]);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
      delete process.env[k];
    }
    // Make auto-detected identity invalid so git refuses.
    git(root, ["config", "user.useConfigOnly", "true"]);
    const err = await commitChanges(host, root, "msg", selection).catch((e) => e);
    expect(err.message).toMatch(/^git commit failed \(exit \d+\):\n/);
    expect(err.message).toMatch(/user\.email|Please tell me who you are|identity/i);
  });

  it("includes hook output in the message", async () => {
    const hook = path.join(root, ".git/hooks/pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\necho 'clang-format check failed' >&2\nexit 1\n");
    await fs.chmod(hook, 0o755);
    const err = await commitChanges(host, root, "msg", selection).catch((e) => e);
    expect(err.message).toBe("git commit failed (exit 1):\nclang-format check failed");
  });

  it("gitFailure falls back to stdout, then to exit code only", () => {
    expect(gitFailure("x", { code: 1, stdout: "out\n", stderr: "  \n" }).message).toBe(
      "x (exit 1):\nout",
    );
    expect(gitFailure("x", { code: 128, stdout: "", stderr: "" }).message).toBe("x (exit 128)");
  });
});
