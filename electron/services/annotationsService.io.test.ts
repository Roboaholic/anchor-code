import { describe, expect, it, vi } from "vitest";
import { HostError, type HostSession } from "../host/types.js";
import { addComment, loadSessions, replyComment, type SessionRecord } from "./annotationsService.js";

function session(id: string, createdAt = "2026-01-01T00:00:00Z"): SessionRecord {
  return {
    version: 1, id, title: id, status: "active", created_at: createdAt,
    ended_at: null, author: "tester", notes: "", comments: [],
  };
}

function makeHost(records: SessionRecord[]) {
  const files = new Map(records.map((record) => [`/repo/.anchor-code/${record.id}.yaml`, JSON.stringify(record)]));
  const host = {
    kind: "ssh",
    exists: vi.fn(async () => true),
    listDir: vi.fn(async () => [...files.keys()].map((file) => ({ name: file.split("/").pop()!, type: "file" }))),
    readFile: vi.fn(async (file: string) => files.get(file)!),
    mkdirp: vi.fn(async () => {}),
    writeFile: vi.fn(async (file: string, text: string) => { files.set(file, text); }),
  };
  return { host, files, api: host as unknown as HostSession };
}

describe("annotation session I/O", () => {
  it("loads at most four files concurrently and preserves newest-first ordering", async () => {
    const records = Array.from({ length: 10 }, (_, index) => session(`session-${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`));
    const { host, api, files } = makeHost(records);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    host.readFile.mockImplementation(async (file) => {
      maximum = Math.max(maximum, ++active);
      await gate;
      active--;
      return files.get(file)!;
    });
    const pending = loadSessions(api, "/repo");
    await vi.waitFor(() => expect(host.readFile).toHaveBeenCalledTimes(4));
    expect(maximum).toBe(4);
    release();
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.sessions.map((record) => record.id)).toEqual(records.map((record) => record.id).reverse());
    expect(host.readFile).toHaveBeenCalledTimes(10);
    expect(maximum).toBe(4);
    expect(host.exists).not.toHaveBeenCalled();
    expect(host.listDir).toHaveBeenCalledOnce();
  });

  it("does not cache sessions modified externally between reads", async () => {
    const record = session("session-1");
    const { host, api, files } = makeHost([record]);
    await loadSessions(api, "/repo");
    files.set("/repo/.anchor-code/session-1.yaml", JSON.stringify({ ...record, notes: "Updated by an agent" }));
    expect((await loadSessions(api, "/repo")).sessions[0]?.notes).toBe("Updated by an agent");
    expect(host.readFile).toHaveBeenCalledTimes(2);
  });

  it("treats only a missing session directory as empty", async () => {
    const { host, api } = makeHost([]);
    host.listDir.mockRejectedValueOnce(new HostError("not_found", "No directory"));
    expect(await loadSessions(api, "/repo")).toEqual({ sessions: [] });
    host.listDir.mockRejectedValueOnce(new HostError("permission", "Permission denied"));
    expect(await loadSessions(api, "/repo")).toEqual({ sessions: [], error: "Permission denied" });
    expect(host.exists).not.toHaveBeenCalled();
  });

  it("reports the first listed invalid file even when a later read fails first", async () => {
    const records = Array.from({ length: 6 }, (_, index) => session(`session-${index}`));
    const { host, api } = makeHost(records);
    const complete = new Map<string, (text: string) => void>();
    host.readFile.mockImplementation((file) => new Promise<string>((resolve) => { complete.set(file, resolve); }));
    const pending = loadSessions(api, "/repo");
    await vi.waitFor(() => expect(complete.size).toBe(4));
    complete.get("/repo/.anchor-code/session-1.yaml")!("invalid: [");
    await Promise.resolve();
    complete.get("/repo/.anchor-code/session-0.yaml")!("not a valid session");
    complete.get("/repo/.anchor-code/session-2.yaml")!(JSON.stringify(records[2]));
    complete.get("/repo/.anchor-code/session-3.yaml")!(JSON.stringify(records[3]));
    const result = await pending;
    expect(result.sessions).toEqual([]);
    expect(result.error).toContain("Failed to parse session-0.yaml");
    expect(host.readFile).toHaveBeenCalledTimes(4);
  });

  it("writes comments and replies without recreating an existing session directory", async () => {
    const { host, api } = makeHost([session("existing")]);
    const added = await addComment(api, {
      repoRoot: "/repo", filePath: "/repo/code.ts", kind: "source",
      startLine: 1, endLine: 1, startColumn: 1, endColumn: 4,
      selectedText: "let", beforeContext: "", afterContext: "", body: "Comment",
    });
    const reply = await replyComment(api, "/repo", added.comments[0]!.id, "Reply");
    expect(reply.comments[0]!.messages.map((message) => message.body)).toEqual(["Comment", "Reply"]);
    expect(host.mkdirp).not.toHaveBeenCalled();
    expect(host.writeFile).toHaveBeenCalledTimes(2);
    // First mutation scans once; the cached active id makes the reply a single-file read.
    expect(host.listDir).toHaveBeenCalledTimes(1);
    expect(host.readFile).toHaveBeenCalledTimes(2);
    expect(host.exists).not.toHaveBeenCalled();
  });

  it("creates the directory for a new session before writing its first comment", async () => {
    const { host, api } = makeHost([]);
    await addComment(api, {
      repoRoot: "/repo", filePath: "/repo/code.ts", kind: "source",
      startLine: 1, endLine: 1, startColumn: 1, endColumn: 4,
      selectedText: "let", beforeContext: "", afterContext: "", body: "Comment",
    });
    expect(host.mkdirp).toHaveBeenCalledExactlyOnceWith("/repo/.anchor-code");
    expect(host.writeFile).toHaveBeenCalledTimes(2);
  });

  it("adds with sessionId using one read + one write and skips the directory scan", async () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      session(index === 0 ? "active-one" : `closed-${index}`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`),
    );
    records[0] = { ...records[0]!, status: "active" };
    for (let i = 1; i < records.length; i++) records[i] = { ...records[i]!, status: "closed" };
    const { host, api } = makeHost(records);
    const added = await addComment(api, {
      repoRoot: "/repo", filePath: "/repo/code.ts", kind: "source",
      startLine: 1, endLine: 1, startColumn: 1, endColumn: 4,
      selectedText: "let", beforeContext: "", afterContext: "", body: "Fast path",
      sessionId: "active-one",
    });
    expect(added.comments).toHaveLength(1);
    expect(host.listDir).not.toHaveBeenCalled();
    expect(host.readFile).toHaveBeenCalledTimes(1);
    expect(host.readFile).toHaveBeenCalledWith("/repo/.anchor-code/active-one.yaml");
    expect(host.writeFile).toHaveBeenCalledTimes(1);
  });

  it("keeps addComment remote work to one read + write after the active id is known", async () => {
    const delayMs = 40;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const records = Array.from({ length: 10 }, (_, index) => {
      const id = `session-${index}`;
      return { ...session(id, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`), status: index === 9 ? "active" as const : "closed" as const };
    });
    const { host, api, files } = makeHost(records);
    host.listDir.mockImplementation(async () => {
      await sleep(delayMs);
      return [...files.keys()].map((file) => ({ name: file.split("/").pop()!, type: "file" as const }));
    });
    host.readFile.mockImplementation(async (file: string) => {
      await sleep(delayMs);
      return files.get(file)!;
    });
    host.writeFile.mockImplementation(async (file: string, text: string) => {
      await sleep(delayMs);
      files.set(file, text);
    });

    const coldStarted = Date.now();
    await addComment(api, {
      repoRoot: "/repo", filePath: "/repo/code.ts", kind: "source",
      startLine: 1, endLine: 1, startColumn: 1, endColumn: 4,
      selectedText: "let", beforeContext: "", afterContext: "", body: "cold",
    });
    const coldMs = Date.now() - coldStarted;

    host.listDir.mockClear();
    host.readFile.mockClear();
    host.writeFile.mockClear();

    const warmStarted = Date.now();
    await addComment(api, {
      repoRoot: "/repo", filePath: "/repo/code.ts", kind: "source",
      startLine: 2, endLine: 2, startColumn: 1, endColumn: 4,
      selectedText: "var", beforeContext: "", afterContext: "", body: "warm",
      sessionId: "session-9",
    });
    const warmMs = Date.now() - warmStarted;

    expect(host.listDir).not.toHaveBeenCalled();
    expect(host.readFile).toHaveBeenCalledTimes(1);
    expect(host.writeFile).toHaveBeenCalledTimes(1);
    // Cold path: listDir + ceil(10/4) read batches + write ≈ 1+3+1 = 5 delays.
    // Warm path: 1 read + 1 write = 2 delays. Require a clear gap.
    expect(coldMs).toBeGreaterThanOrEqual(delayMs * 4);
    expect(warmMs).toBeLessThan(delayMs * 3);
    expect(warmMs).toBeLessThan(coldMs);
  });
});
