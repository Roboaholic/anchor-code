import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  addComment,
  copyYamlPath,
  endSession,
  ensureActiveSession,
  loadSessions,
  locateGitRoot,
  newSession,
} from "./annotationsService.js";
import { selectActiveSession } from "../../src/core/annotations/sessionSchema.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("annotationsService (integration, YAML on disk)", () => {
  let root: string;
  let host: LocalHostSession;
  let filePath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-ann-"));
    host = new LocalHostSession("ann-test");
    git(root, ["init"]);
    filePath = path.join(root, "src", "app.ts");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      ["line1", "const result = legacyTransform(input)", "line3"].join("\n"),
      "utf8",
    );
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "code"]);
  });

  afterEach(async () => {
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("locates git root from nested file", async () => {
    const found = await locateGitRoot(host, filePath);
    expect(path.resolve(found!)).toBe(path.resolve(root));
  });

  it("creates active session, writes comment YAML, copies path", async () => {
    const session = await ensureActiveSession(host, root);
    expect(session.status).toBe("active");

    const updated = await addComment(host, {
      repoRoot: root,
      filePath,
      kind: "source",
      startLine: 2,
      endLine: 2,
      startColumn: 1,
      endColumn: 40,
      selectedText: "legacyTransform",
      beforeContext: "line1",
      afterContext: "line3",
      body: "do not use legacy",
    });

    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0]!.messages[0]!.body).toBe("do not use legacy");
    expect(updated.comments[0]!.target.file_path).toBe("src/app.ts");

    const abs = await copyYamlPath(host, root);
    expect(abs.includes(".anchor-code")).toBe(true);
    expect(abs.endsWith(".yaml")).toBe(true);

    const disk = await fs.readFile(abs, "utf8");
    expect(disk).toContain("legacyTransform");
    expect(disk).toContain("do not use legacy");

    // reload validates zod path
    const { sessions, error } = await loadSessions(host, root);
    expect(error).toBeUndefined();
    expect(selectActiveSession(sessions)?.id).toBe(session.id);
  });

  it("ends session and allows a new active", async () => {
    await ensureActiveSession(host, root);
    await endSession(host, root);
    const { sessions } = await loadSessions(host, root);
    expect(selectActiveSession(sessions)).toBeNull();

    const next = await newSession(host, root);
    expect(next.status).toBe("active");
  });
});
