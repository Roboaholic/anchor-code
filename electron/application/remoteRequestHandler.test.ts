import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostManager } from "../host/hostManager.js";
import { LocalHostSession } from "../host/localHost.js";
import { TerminalService } from "../services/terminalService.js";
import type { AnchorApplicationEvent } from "./applicationEvents.js";
import { AnchorApplication } from "./anchorApplication.js";
import {
  RemoteRequestHandler,
  remoteStatusForError,
} from "./remoteRequestHandler.js";

async function expectForbidden(action: Promise<unknown>): Promise<void> {
  try {
    await action;
    throw new Error("expected request to fail");
  } catch (error) {
    expect(remoteStatusForError(error)).toBe(403);
  }
}

describe("RemoteRequestHandler security boundaries", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function applicationFixture() {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-remote-workspace-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-remote-outside-"));
    tempRoots.push(workspace, outside);
    const repo = path.join(workspace, "repo");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await fs.mkdir(path.join(workspace, "not-a-repo"));
    const host = new LocalHostSession("remote-security");
    host.workspaceRoot = workspace;
    const hosts = new HostManager(host);
    const terminal = new TerminalService(() => null, () => hosts.session);
    const application = new AnchorApplication({ hosts, terminal });
    return {
      workspace,
      outside,
      repo,
      handler: new RemoteRequestHandler({ appVersion: "test", application }),
    };
  }

  it("rejects repositories outside the active workspace and undiscovered roots", async () => {
    const fixture = await applicationFixture();
    await expectForbidden(fixture.handler.handle({
      method: "GET",
      path: "/api/v1/history/log",
      query: { repoRoot: fixture.outside },
    }));
    await expectForbidden(fixture.handler.handle({
      method: "GET",
      path: "/api/v1/history/status",
      query: { repoRoot: path.join(fixture.workspace, "not-a-repo") },
    }));
  });

  it("rejects a diff path that escapes an approved repository", async () => {
    const fixture = await applicationFixture();
    await expectForbidden(fixture.handler.handle({
      method: "POST",
      path: "/api/v1/history/file-diff",
      body: {
        repoRoot: fixture.repo,
        base: "HEAD",
        head: "worktree",
        path: "../outside.txt",
        status: "M",
      },
    }));
  });

  it("rejects comment storage outside the active workspace", async () => {
    const fixture = await applicationFixture();
    await expectForbidden(fixture.handler.handle({
      method: "GET",
      path: "/api/v1/comments",
      query: { repoRoot: fixture.outside },
    }));
  });

  it("accepts an approved nested repo but stores comments at the workspace boundary", async () => {
    const fixture = await applicationFixture();
    const response = await fixture.handler.handle({
      method: "POST",
      path: "/api/v1/comments/session",
      body: { repoRoot: fixture.repo, title: "Remote review" },
    });
    expect(response.status).toBe(200);
    expect((response.body as { filePath?: string }).filePath).toMatch(
      new RegExp(`^${fixture.workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    expect((response.body as { filePath?: string }).filePath).not.toContain(
      `${path.sep}repo${path.sep}.anchor-code`,
    );
  });
});

describe("RemoteRequestHandler bounded events", () => {
  function eventFixture() {
    let listener: ((event: AnchorApplicationEvent) => void) | null = null;
    const application = {
      subscribe: vi.fn((next: (event: AnchorApplicationEvent) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      }),
    } as unknown as AnchorApplication;
    const handler = new RemoteRequestHandler({ appVersion: "test", application });
    return {
      application,
      handler,
      publish(event: AnchorApplicationEvent) {
        listener?.(event);
      },
    };
  }

  it("does not subscribe or retain events while remote access is inactive", async () => {
    const fixture = eventFixture();
    expect(fixture.application.subscribe).not.toHaveBeenCalled();
    fixture.publish({
      type: "terminal",
      event: { type: "data", id: "term", data: "ignored", seq: 1 },
    });
    const inactive = await fixture.handler.handle({
      method: "GET",
      path: "/api/v1/terminal-events",
      query: { after: "0", waitMs: "0" },
    });
    expect(inactive.body).toMatchObject({ events: [], bootstrapRequired: false });

    fixture.handler.setActive(true);
    fixture.publish({
      type: "terminal",
      event: { type: "data", id: "term", data: "visible", seq: 1 },
    });
    const active = await fixture.handler.handle({
      method: "GET",
      path: "/api/v1/terminal-events",
      query: { after: "0", waitMs: "0" },
    });
    expect((active.body as { events: unknown[] }).events).toHaveLength(1);

    fixture.handler.setActive(false);
    fixture.publish({
      type: "terminal",
      event: { type: "data", id: "term", data: "ignored-again", seq: 2 },
    });
    const disabled = await fixture.handler.handle({
      method: "GET",
      path: "/api/v1/terminal-events",
      query: { after: "0", waitMs: "0" },
    });
    expect(disabled.body).toMatchObject({ events: [], bootstrapRequired: true });
  });

  it("bounds cached event bytes and requests bootstrap after cursor eviction", async () => {
    const fixture = eventFixture();
    fixture.handler.setActive(true);
    const data = "x".repeat(4 * 1024);
    for (let seq = 1; seq <= 600; seq += 1) {
      fixture.publish({
        type: "terminal",
        event: { type: "data", id: "term", data, seq },
      });
    }
    const response = await fixture.handler.handle({
      method: "GET",
      path: "/api/v1/terminal-events",
      query: { after: "0", waitMs: "0" },
    });
    const body = response.body as { bootstrapRequired: boolean; events: unknown[] };
    expect(body.bootstrapRequired).toBe(true);
    expect(body.events.length).toBeLessThan(600);
  });
});
