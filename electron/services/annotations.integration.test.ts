import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  addComment,
  copyYamlPath,
  deleteComment,
  editComment,
  endSession,
  ensureActiveSession,
  exportSession,
  loadSessions,
  locateGitRoot,
  newSession,
  restoreSession,
  setCommentStatus,
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
    expect(found).toBe(root);
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
      startColumn: 16,
      endColumn: 31,
      selectedText: "legacyTransform",
      beforeContext: "line1",
      afterContext: "line3",
      lineText: "const result = legacyTransform(input)",
      body: "avoid legacy",
    });
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0]!.target.line_text).toContain("legacyTransform");

    const abs = await copyYamlPath(host, root);
    expect(abs.includes(".anchor-code")).toBe(true);
    expect(abs.endsWith(".yaml")).toBe(true);

    const onDisk = await fs.readFile(abs, "utf8");
    expect(onDisk).toContain("avoid legacy");
  });

  it("edits, sets status, deletes comments", async () => {
    await ensureActiveSession(host, root);
    const withComment = await addComment(host, {
      repoRoot: root,
      filePath,
      kind: "source",
      startLine: 2,
      endLine: 2,
      startColumn: 1,
      endColumn: 10,
      selectedText: "const",
      beforeContext: "line1",
      afterContext: "line3",
      body: "first body",
    });
    const commentId = withComment.comments[0]!.id;

    const edited = await editComment(host, root, commentId, "updated body");
    expect(edited.comments[0]!.messages[0]!.body).toBe("updated body");

    const statused = await setCommentStatus(
      host,
      root,
      commentId,
      "need_modify",
    );
    expect(statused.comments[0]!.status).toBe("need_modify");

    const deleted = await deleteComment(host, root, commentId);
    expect(deleted.comments).toHaveLength(0);
  });

  it("ends session with anch-review export and allows restore", async () => {
    await ensureActiveSession(host, root);
    await addComment(host, {
      repoRoot: root,
      filePath,
      kind: "source",
      startLine: 2,
      endLine: 2,
      startColumn: 1,
      endColumn: 5,
      selectedText: "const",
      beforeContext: "line1",
      afterContext: "line3",
      body: "export me",
    });

    const ended = await endSession(host, root);
    expect(ended.session?.status).toBe("closed");
    expect(ended.exportPath).toBeTruthy();
    const exportText = await fs.readFile(ended.exportPath!, "utf8");
    const payload = JSON.parse(exportText) as {
      session: { status: string };
      entries: Array<{ reviewStatus: string; body: string }>;
    };
    expect(payload.session.status).toBe("stopped");
    expect(payload.entries[0]?.body).toBe("export me");
    expect(payload.entries[0]?.reviewStatus).toBe("discussing");

    const { sessions } = await loadSessions(host, root);
    expect(selectActiveSession(sessions)).toBeNull();

    const closedId = ended.session!.id;
    const restored = await restoreSession(host, root, closedId);
    expect(restored.status).toBe("active");
    expect(restored.comments).toHaveLength(1);

    const after = await loadSessions(host, root);
    expect(selectActiveSession(after.sessions)?.id).toBe(closedId);
  });

  it("exports closed session on demand", async () => {
    await ensureActiveSession(host, root);
    await addComment(host, {
      repoRoot: root,
      filePath,
      kind: "source",
      startLine: 1,
      endLine: 1,
      startColumn: 1,
      endColumn: 5,
      selectedText: "line1",
      beforeContext: "",
      afterContext: "const result = legacyTransform(input)",
      body: "note",
    });
    const ended = await endSession(host, root, { export: false });
    const exported = await exportSession(host, root, ended.session!.id);
    expect(exported.exportPath.includes(`${path.sep}exports${path.sep}`)).toBe(
      true,
    );
    expect(exported.payload.entries).toHaveLength(1);
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
