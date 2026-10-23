import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { CommentFacade } from "./commentFacade.js";
import type { HostSession } from "../host/types.js";
import type { SessionRecord } from "../services/annotationsService.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHost(profileId: string) {
  const session: SessionRecord = {
    version: 1, id: "session-1", title: "Review", status: "active", created_at: "now", ended_at: null,
    author: "tester", notes: "", comments: [{ id: "comment-1", status: "discussing", author: "tester",
      created_at: "now", updated_at: "now", target: { file_path: "app.ts", kind: "source", start_line: 1,
        end_line: 1, start_column: 1, end_column: 4, selected_text: "app", before_context: "", after_context: "" },
      messages: [{ id: "message-1", author: "tester", created_at: "now", body: "original" }] }],
  };
  let yaml = JSON.stringify(session);
  const host = {
    kind: "ssh" as const, profileId, workspaceRoot: "/repo", mkdirp: vi.fn(async () => {}),
    listDir: vi.fn(async () => [{ name: "session-1.yaml", type: "file" }]),
    readFile: vi.fn(async () => yaml),
    writeFile: vi.fn(async (_file: string, text: string) => { yaml = text; }),
  };
  return { host, api: host as unknown as HostSession, saved: () => parse(yaml) as SessionRecord };
}

function makeFacade(host: HostSession) {
  const hosts = { session: host };
  const workspace = { root: () => hosts.session.workspaceRoot!, safePath: (path: string) => path,
    safeRepoPath: (_root: string, path: string) => path };
  return { hosts, facade: new CommentFacade(hosts as never, workspace as never) };
}

describe("comment mutation queue", () => {
  it("preserves concurrent replies and leaves read-only lists available", async () => {
    const { host, api, saved } = makeHost("first");
    const { facade } = makeFacade(api);
    const gate = deferred();
    const write = host.writeFile.getMockImplementation()!;
    host.writeFile.mockImplementationOnce(async (file, text) => { await gate.promise; await write(file, text); });
    const first = facade.reply("/repo", "comment-1", "first");
    const second = facade.reply("/repo", "comment-1", "second");
    await vi.waitFor(() => expect(host.writeFile).toHaveBeenCalledTimes(1));
    expect(host.readFile).toHaveBeenCalledTimes(1);
    expect((await facade.list("/repo")).sessions).toHaveLength(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(saved().comments[0]!.messages.map((message) => message.body)).toEqual(["original", "first", "second"]);
  });

  it("keeps queued saves on the original host while another host proceeds independently", async () => {
    const original = makeHost("first");
    const remote = makeHost("second");
    const { facade, hosts } = makeFacade(original.api);
    const gate = deferred();
    const write = original.host.writeFile.getMockImplementation()!;
    original.host.writeFile.mockImplementationOnce(async (file, text) => { await gate.promise; await write(file, text); });
    const first = facade.reply("/repo", "comment-1", "first");
    const second = facade.reply("/repo", "comment-1", "second");
    hosts.session = remote.api;
    await facade.reply("/repo", "comment-1", "remote");
    expect(remote.saved().comments[0]!.messages.map((message) => message.body)).toEqual(["original", "remote"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(original.saved().comments[0]!.messages.map((message) => message.body)).toEqual(["original", "first", "second"]);
  });

  it("allows retry after a failed write without pretending the first reply was saved", async () => {
    const { host, api, saved } = makeHost("first");
    const { facade } = makeFacade(api);
    host.writeFile.mockRejectedValueOnce(new Error("Disk is full"));
    const failed = facade.reply("/repo", "comment-1", "failed");
    const retried = facade.reply("/repo", "comment-1", "retry");
    await expect(failed).rejects.toThrow("Disk is full");
    await retried;
    expect(saved().comments[0]!.messages.map((message) => message.body)).toEqual(["original", "retry"]);
  });
});
