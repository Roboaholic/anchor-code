import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { spawnLocalPty } from "./localPty.js";
import { OpenSshHostSession } from "./openSshHost.js";
import type { PtyHandle } from "./types.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("./localPty.js", () => ({ spawnLocalPty: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const ptyMock = vi.mocked(spawnLocalPty);

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
  readonly pid = undefined;
  end(code = 0): void { this.emit("close", code); }
}

function fakeChild(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

function fakePty() {
  let dataCallback: (data: string) => void = () => {};
  let exitCallback: (code: number) => void = () => {};
  const handle: PtyHandle = {
    id: "local-pty",
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((callback) => { dataCallback = callback; }),
    onExit: vi.fn((callback) => { exitCallback = callback; }),
  };
  ptyMock.mockResolvedValueOnce({ handle, shell: "ssh", cwd: process.cwd() });
  return { handle, data: (text: string) => dataCallback(text), exit: (code: number) => exitCallback(code) };
}

describe("OpenSshHostSession native transport", () => {
  let host: OpenSshHostSession;
  const children: FakeChild[] = [];
  const child = () => { const result = fakeChild(); children.push(result); return result; };

  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    ptyMock.mockReset();
    host = new OpenSshHostSession({ profileId: "ssh-native", configHost: "work-alias", persistentReads: false });
  });
  afterEach(async () => {
    for (const process of children.splice(0)) process.end();
    await host.dispose();
    vi.useRealTimers();
  });

  it("preserves the alias and native config, forces strict noninteractive fresh connections", async () => {
    const process = child();
    const result = host.run("/workspace", "printf", ["%s", "hello"]);
    const [executable, args, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe("ssh");
    expect(options).toMatchObject({ shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    expect(args).toEqual(expect.arrayContaining([
      "BatchMode=yes", "StrictHostKeyChecking=yes", "VerifyHostKeyDNS=no", "UpdateHostKeys=no",
      "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "RemoteCommand=none",
      "SessionType=default", "ForkAfterAuthentication=no", "StdinNull=no", "RequestTTY=no", "-T",
    ]));
    expect(args?.slice(-3, -1)).toEqual(["--", "work-alias"]);
    expect(args).not.toEqual(expect.arrayContaining(["-F", "-i", "-l", "-p", "-J"]));
    expect(process.stdin.writableEnded).toBe(true);
    process.stdout.write("hello");
    process.end();
    expect(await result).toEqual({ stdout: "hello", stderr: "", code: 0 });
  });

  it("reuses a strictly authenticated search connection and sends query arguments as JSON", async () => {
    const process = child();
    const sent: Array<{ id: string; cwd: string; cmd: string; args: string[] }> = [];
    process.stdin.on("data", (chunk) => { sent.push(JSON.parse(chunk.toString())); });
    const query = "查询 ' $(echo unsafe)";
    const first = host.runSearch("/workspace/目录", "rg", ["--", query, "."]);
    const [executable, args, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe("ssh");
    expect(options).toMatchObject({ shell: false, stdio: ["pipe", "pipe", "pipe"] });
    expect(args).toEqual(expect.arrayContaining([
      "BatchMode=yes", "StrictHostKeyChecking=yes", "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "-T",
    ]));
    expect(args?.slice(-3, -1)).toEqual(["--", "work-alias"]);
    expect(args?.at(-1)).not.toContain(query);
    process.stdout.write(`${JSON.stringify({ ev: "ready" })}\n`);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ cwd: "/workspace/目录", cmd: "rg", args: ["--", query, "."] });
    process.stdout.write(`${JSON.stringify({ id: sent[0]!.id, ev: "exit", code: 1 })}\n`);
    await expect(first).resolves.toMatchObject({ code: 1 });
    const second = host.runSearch("/workspace", "git", ["ls-files"]);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    process.stdout.write(`${JSON.stringify({ id: sent[1]!.id, ev: "exit", code: 0 })}\n`);
    await expect(second).resolves.toMatchObject({ code: 0 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    host.disposeSearchHelper();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it.each(["", "-oProxyCommand=bad", "bad alias", "alias\nother", "alias\0other"])("rejects unsafe alias %j before spawning", (alias) => {
    expect(() => new OpenSshHostSession({ profileId: "test", configHost: alias })).toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("streams split UTF-8 without corrupting stdout or stderr", async () => {
    const process = child();
    const chunks: string[] = [];
    const result = host.run("/", "print", [], { onStdoutChunk: (text) => chunks.push(text) });
    for (const byte of Buffer.from("中文🦊")) process.stdout.write(Buffer.from([byte]));
    for (const byte of Buffer.from("échec")) process.stderr.write(Buffer.from([byte]));
    process.end();
    expect(await result).toEqual({ stdout: "中文🦊", stderr: "échec", code: 0 });
    expect(chunks.join("")).toBe("中文🦊");
  });

  it("forwards stdin unchanged, including NUL and Unicode content", async () => {
    const process = child();
    const payload = "quote'\n中文\0tail";
    const result = host.run("/", "cat", [], { stdin: payload });
    expect(process.stdin.read().toString()).toBe(payload);
    process.end();
    await result;
  });

  it("does not spawn for an already-aborted request", async () => {
    const controller = new AbortController(); controller.abort();
    expect(await host.run("/", "cat", [], { signal: controller.signal })).toMatchObject({ aborted: true, code: 0 });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("supports abort from a streaming callback and retains partial output", async () => {
    const process = child();
    const controller = new AbortController();
    const earlyExit = vi.fn();
    const result = host.run("/", "slow", [], {
      signal: controller.signal,
      onStdoutChunk: () => controller.abort(), earlyExit,
    });
    process.stdout.write("first");
    expect(await result).toEqual({ stdout: "first", stderr: "", code: 0, aborted: true });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(earlyExit).not.toHaveBeenCalled();
    process.stdout.write("ignored");
    process.end();
  });

  it("stops early successfully and escalates an unresponsive process", async () => {
    vi.useFakeTimers();
    const process = child();
    const result = host.run("/", "search", [], { earlyExit: (text) => text.includes("hit") });
    process.stdout.write("hit\n");
    expect(await result).toEqual({ stdout: "hit\n", stderr: "", code: 0, earlyExit: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(process.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(process.stdout.destroyed).toBe(true);
    await host.dispose();
  });

  it("rejects timed-out commands and disposes within its kill grace period", async () => {
    vi.useFakeTimers();
    const process = child();
    const result = host.run("/", "slow", [], { timeoutMs: 50 });
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    const disposed = host.dispose();
    await vi.advanceTimersByTimeAsync(250);
    await disposed;
    expect(process.kill).toHaveBeenLastCalledWith("SIGKILL");
    await expect(host.run("/", "true", [])).rejects.toMatchObject({ code: "disconnected" });
  });

  it("clears abort listeners and timers on normal completion", async () => {
    vi.useFakeTimers();
    const process = child();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = host.run("/", "true", [], { signal: controller.signal });
    process.end();
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("treats observer exceptions safely and rejects failing early-exit callbacks", async () => {
    const process = child();
    const result = host.run("/", "true", [], {
      onStdoutChunk: () => { throw new Error("observer failed"); },
      earlyExit: () => { throw new Error("predicate failed"); },
    });
    process.stdout.write("partial");
    await expect(result).rejects.toMatchObject({ code: "failed", causeDetail: "predicate failed" });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports a missing ssh executable explicitly", async () => {
    const process = child();
    const result = host.run("/", "true", []);
    process.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }));
    await expect(result).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining("Install OpenSSH") });
  });

  it.each([
    "Host key verification failed.",
    "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
    "No ED25519 host key is known for work-alias and you have requested strict checking.",
  ])("gives a trusted-fingerprint recovery path for %s", async (diagnostic) => {
    const process = child();
    const result = host.run("/", "true", []);
    process.stderr.write(diagnostic); process.end(255);
    await expect(result).rejects.toMatchObject({
      code: "disconnected", causeDetail: diagnostic,
      message: expect.stringContaining("Verify the server fingerprint with a trusted source"),
    });
  });

  it("can reconnect after a failed connection without retaining stale client state", async () => {
    const first = child(); const failure = host.run("/", "true", []);
    first.stderr.write("Permission denied (publickey)."); first.end(255);
    await expect(failure).rejects.toMatchObject({ code: "disconnected", message: expect.stringContaining("ssh-add") });
    expect(first.kill).not.toHaveBeenCalled();
    const second = child(); const success = host.run("/", "true", []);
    second.end();
    expect((await success).code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("preserves ordinary nonzero remote exit statuses", async () => {
    const process = child(); const result = host.run("/", "false", []);
    process.end(17);
    expect((await result).code).toBe(17);
  });

  it("does not turn permission failures into missing-file results", async () => {
    const process = child(); const result = host.exists("/restricted/file");
    process.stderr.write("stat: cannot stat '/restricted/file': Permission denied\n");
    process.end(1);
    await expect(result).rejects.toMatchObject({ code: "permission" });
  });

  it("rejects unavailable stat and malformed metadata explicitly", async () => {
    const first = child(); const missing = host.stat("/file");
    first.stderr.write("bash: stat: command not found\n"); first.end(127);
    await expect(missing).rejects.toMatchObject({ code: "failed" });
    const second = child(); const bad = host.stat("/file");
    second.stdout.write("file|NaN|123\n"); second.end();
    await expect(bad).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("Invalid file metadata") });
  });

  it("rejects malformed directory frames instead of inventing filenames", async () => {
    const process = child(); const result = host.listDir("/dir");
    process.stdout.write("banner\nf\0name\0"); process.end();
    await expect(result).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("Invalid directory entry") });
  });

  it("terminates active runs on disposal and allows a fresh session", async () => {
    const process = child(); const result = host.run("/", "slow", []);
    const rejected = expect(result).rejects.toMatchObject({ code: "disconnected" });
    const disposed = host.dispose();
    process.end();
    await Promise.all([rejected, disposed]);
    host = new OpenSshHostSession({ profileId: "ssh-native", configHost: "work-alias", persistentReads: false });
    const next = child(); const nextResult = host.run("/", "true", []); next.end();
    expect((await nextResult).code).toBe(0);
  });

  it("shares the command budget across workspace and browse sessions for an alias", async () => {
    const browse = new OpenSshHostSession({ profileId: "browse", configHost: "work-alias", persistentReads: false });
    try {
      const first = child(); const run = host.run("/", "git", ["status"]);
      const second = child(); const read = browse.readFile("/file");
      const third = child(); const list = host.listDir("/dir");
      const fourth = child(); const stat = browse.stat("/file");
      expect(spawnMock).toHaveBeenCalledTimes(2);
      first.end(); expect(spawnMock).toHaveBeenCalledTimes(3);
      second.stdout.write("data"); second.end(); expect(spawnMock).toHaveBeenCalledTimes(4);
      third.stdout.write("f\0file\0"); third.end();
      fourth.stdout.write("file|4|1700000000\n"); fourth.end();
      expect(await Promise.all([run, read, list, stat])).toEqual([
        { stdout: "", stderr: "", code: 0 }, "data", [{ name: "file", type: "file" }],
        { isFile: true, isDir: false, size: 4, mtimeMs: 1700000000000 },
      ]);
    } finally { await browse.dispose(); }
  });

  it("cancels queued requests without spawning or taking another command's slot", async () => {
    const first = child(); const run1 = host.run("/", "slow", []);
    const second = child(); const run2 = host.run("/", "slow", []);
    const controller = new AbortController();
    const queued = host.run("/", "never-started", [], { signal: controller.signal });
    controller.abort();
    expect(await queued).toEqual({ stdout: "", stderr: "", code: 0, aborted: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(first.kill).not.toHaveBeenCalled(); expect(second.kill).not.toHaveBeenCalled();
    first.end(); second.end(); await Promise.all([run1, run2]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("disposes a queued session without affecting another session sharing its alias", async () => {
    const first = child(); const run1 = host.run("/", "slow", []);
    const second = child(); const run2 = host.run("/", "slow", []);
    const browse = new OpenSshHostSession({ profileId: "browse", configHost: "work-alias", persistentReads: false });
    const queued = browse.readFile("/file");
    const rejected = expect(queued).rejects.toMatchObject({ code: "disconnected" });
    await browse.dispose(); await rejected;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(first.kill).not.toHaveBeenCalled(); expect(second.kill).not.toHaveBeenCalled();
    first.end(); second.end(); await Promise.all([run1, run2]);
    const next = child(); const result = host.readFile("/file"); next.stdout.write("still connected"); next.end();
    expect(await result).toBe("still connected");
  });

  it("holds aborted command slots until close or kill escalation, releasing only once", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const first = child(); const run1 = host.run("/", "slow", [], { signal: controller.signal });
    const second = child(); const run2 = host.run("/", "slow", []);
    const third = child(); const run3 = host.run("/", "next", []);
    const fourth = child(); const run4 = host.run("/", "last", []);
    controller.abort(); await run1;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(first.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(spawnMock).toHaveBeenCalledTimes(3);
    first.end(); expect(spawnMock).toHaveBeenCalledTimes(3);
    second.end(); expect(spawnMock).toHaveBeenCalledTimes(4);
    third.end(); fourth.end(); await Promise.all([run2, run3, run4]);
  });

  it("includes queue time in timeouts and removes expired requests", async () => {
    vi.useFakeTimers();
    const first = child(); const run1 = host.run("/", "slow", [], { timeoutMs: 0 });
    const second = child(); const run2 = host.run("/", "slow", [], { timeoutMs: 0 });
    const queued = host.run("/", "never-started", [], { timeoutMs: 50 });
    const rejected = expect(queued).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(50); await rejected;
    first.end(); second.end(); await Promise.all([run1, run2]);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("never starts queued commands while disposing running commands", async () => {
    const first = child(); const run1 = host.run("/", "slow", []);
    const second = child(); const run2 = host.run("/", "slow", []);
    const queued = host.run("/", "never-started", []);
    const rejected = [run1, run2, queued].map((run) => expect(run).rejects.toMatchObject({ code: "disconnected" }));
    first.kill.mockImplementation(() => { first.end(); return true; });
    second.kill.mockImplementation(() => { second.end(); return true; });
    await host.dispose(); await Promise.all(rejected);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("does not leak a slot when spawning throws synchronously", async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    await expect(host.run("/", "true", [])).rejects.toMatchObject({ code: "failed" });
    const first = child(); const run1 = host.run("/", "true", []);
    const second = child(); const run2 = host.run("/", "true", []);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    first.end(); second.end(); await Promise.all([run1, run2]);
  });

  it.each([
    { method: "readFile" as const, output: "file data", expected: "file data" },
    { method: "listDir" as const, output: "f\0file\0", expected: [{ name: "file", type: "file" }] },
    { method: "stat" as const, output: "file|9|123\n", expected: { isFile: true, isDir: false, size: 9, mtimeMs: 123000 } },
  ])("retries a transient connection closure for $method, discarding partial output", async ({ method, output, expected }) => {
    vi.useFakeTimers();
    const first = child(); const result = host[method]("/file");
    first.stdout.write("incomplete");
    first.stderr.write("kex_exchange_identification: read: Connection reset by peer\n"); first.end(255);
    const second = child();
    await vi.advanceTimersByTimeAsync(250);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    second.stdout.write(output); second.end();
    expect(await result).toEqual(expected);
  });

  it("bounds transient file read retries to three total attempts", async () => {
    vi.useFakeTimers();
    const first = child(); const result = host.readFile("/file");
    const rejected = expect(result).rejects.toMatchObject({ code: "disconnected", causeDetail: "Connection closed by 127.0.0.1 port 22" });
    first.stderr.write("Connection closed by 127.0.0.1 port 22"); first.end(255);
    const second = child(); await vi.advanceTimersByTimeAsync(250);
    second.stderr.write("Connection closed by 127.0.0.1 port 22"); second.end(255);
    const third = child(); await vi.advanceTimersByTimeAsync(400);
    third.stderr.write("Connection closed by 127.0.0.1 port 22"); third.end(255);
    await rejected; await vi.advanceTimersByTimeAsync(1000);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    "Host key verification failed.\nConnection closed by 127.0.0.1 port 22",
    "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
    "Permission denied (publickey).\nConnection reset by peer",
    "ssh: connect to host work-alias port 22: Connection refused",
  ])("does not retry security failures or unrelated diagnostics: %s", async (diagnostic) => {
    vi.useFakeTimers();
    const first = child(); const result = host.readFile("/file");
    first.stderr.write(diagnostic); first.end(255);
    await expect(result).rejects.toMatchObject({ code: "disconnected" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each(["run", "writeFile", "mkdirp", "remove", "rename", "copyPath"] as const)("never retries %s after connection loss", async (method) => {
    vi.useFakeTimers();
    const first = child();
    const result = method === "run" ? host.run("/", "cat", ["/file"])
      : method === "writeFile" || method === "rename" || method === "copyPath" ? host[method]("/file", "value")
      : host[method]("/file");
    first.stderr.write("kex_exchange_identification: Connection closed by remote host"); first.end(255);
    await expect(result).rejects.toMatchObject({ code: "disconnected" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("cancels retry backoff immediately on disposal", async () => {
    vi.useFakeTimers();
    const first = child(); const result = host.readFile("/file");
    const rejected = expect(result).rejects.toMatchObject({ code: "disconnected" });
    first.stderr.write("kex_exchange_identification: Connection closed by remote host"); first.end(255);
    await vi.advanceTimersByTimeAsync(0);
    await host.dispose(); await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not reserve command slots for long-lived terminals", async () => {
    fakePty(); const terminal = await host.openPty("~", 80, 24);
    const first = child(); const run1 = host.run("/", "true", []);
    const second = child(); const run2 = host.run("/", "true", []);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    first.end(); second.end(); await Promise.all([run1, run2]);
    terminal.kill();
  });

  it("starts a native PTY with local cwd, remote env, and forced remote TTY", async () => {
    const raw = fakePty();
    const handle = await host.openPty("/remote dir", 91, 31, {
      command: "agent", args: ["space quote'\n$(bad)"], env: { AGENT_PATH: "/remote value", "BAD;key": "ignored" },
    });
    const [cwd, cols, rows, options] = ptyMock.mock.calls[0]!;
    expect(cwd).toBe(process.cwd()); expect([cols, rows]).toEqual([91, 31]);
    expect(options?.shell).toBe("ssh"); expect(options?.env).toBeUndefined();
    expect(options?.args).toEqual(expect.arrayContaining(["-tt", "RequestTTY=force", "StrictHostKeyChecking=yes"]));
    expect(options?.args?.at(-1)).toContain("AGENT_PATH");
    expect(options?.args?.at(-1)).not.toContain("BAD;key");
    raw.data("first frame");
    const data = vi.fn(); handle.onData(data); expect(data).toHaveBeenCalledWith("first frame");
    handle.write("text"); handle.resize(100, 40);
    expect(raw.handle.write).toHaveBeenCalledWith("text");
    expect(raw.handle.resize).toHaveBeenCalledWith(100, 40);
    raw.exit(7);
    const exit = vi.fn(); handle.onExit(exit); expect(exit).toHaveBeenCalledWith(7);
    await host.dispose(); expect(raw.handle.kill).not.toHaveBeenCalled();
  });

  it("adds host-key guidance to failed terminals and replays early exit", async () => {
    const raw = fakePty(); const handle = await host.openPty("~", 80, 24);
    raw.data("Host key verification failed.\r\n"); raw.exit(255);
    const data = vi.fn(); handle.onData(data);
    expect(data).toHaveBeenCalledWith(expect.stringContaining("Verify the server fingerprint"));
    const exit = vi.fn(); handle.onExit(exit); expect(exit).toHaveBeenCalledWith(255);
  });

  it("retains data and exit already buffered by the local PTY helper", async () => {
    const raw = fakePty();
    vi.mocked(raw.handle.onData).mockImplementation((callback) => callback("Host key verification failed.\r\n"));
    vi.mocked(raw.handle.onExit).mockImplementation((callback) => callback(255));
    const handle = await host.openPty("~", 80, 24);
    const data = vi.fn(); const exit = vi.fn(); handle.onData(data); handle.onExit(exit);
    expect(data).toHaveBeenCalledWith(expect.stringContaining("normal terminal"));
    expect(exit).toHaveBeenCalledWith(255);
    await host.dispose(); expect(raw.handle.kill).not.toHaveBeenCalled();
  });

  it("kills terminal handles on dispose and blocks later writes", async () => {
    const raw = fakePty(); const handle = await host.openPty("~", 80, 24);
    await host.dispose(); handle.write("late"); handle.kill();
    expect(raw.handle.kill).toHaveBeenCalledTimes(1);
    expect(raw.handle.write).not.toHaveBeenCalled();
  });

  it("kills a terminal whose asynchronous startup races with disposal", async () => {
    const raw = fakePty();
    ptyMock.mockReset();
    let resolve!: (value: Awaited<ReturnType<typeof spawnLocalPty>>) => void;
    ptyMock.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const result = host.openPty("~", 80, 24);
    await host.dispose();
    resolve({ handle: raw.handle, shell: "ssh", cwd: process.cwd() });
    await expect(result).rejects.toMatchObject({ code: "disconnected" });
    expect(raw.handle.kill).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform === "win32").each([
  { persistentReads: true, mode: "persistent helper reads" },
  { persistentReads: false, mode: "one ssh per operation" },
])("OpenSshHostSession remote shell fixtures (no network, $mode)", ({ persistentReads }) => {
  let root: string;
  let host: OpenSshHostSession;
  let fixturePath: string;

  beforeEach(async () => {
    spawnMock.mockReset();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-openssh-test-"));
    fixturePath = process.env.PATH || "/usr/bin:/bin";
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // Run only the generated remote command in a local bash. Never invoke ssh,
    // read SSH configuration/keys, or connect to a real host during these tests.
    spawnMock.mockImplementation((_command, args, options) => actual.spawn("bash", ["-c", (args as string[]).at(-1)!], {
      ...options,
      cwd: root,
      env: { HOME: root, PATH: fixturePath, LC_ALL: "C" },
    }));
    host = new OpenSshHostSession({ profileId: "fixture", configHost: "never-connected", persistentReads });
  });
  afterEach(async () => {
    await host.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("quotes cwd and argv without interpreting shell syntax", async () => {
    const cwd = path.join(root, "dir with space'\n\\backslash"); await fs.mkdir(cwd);
    const value = "$(touch INJECTED); quote'\n\\literal";
    const result = await host.run(cwd, "printf", ["%s|%s", value, ""]);
    expect(result.stdout).toBe(`${value}|`);
    expect(result.code).toBe(0);
    await expect(fs.stat(path.join(cwd, "INJECTED"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await host.run(cwd, "pwd", [])).stdout).toBe(`${cwd}\n`);
  });

  it("reads binary image bytes intact through the text-only SSH channel", async () => {
    const file = `${root}/diagrams dir/结构 '图.svg`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.concat([
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 13) % 256)),
    ]);
    await fs.writeFile(file, bytes);
    expect((await host.readFileBytes(file)).equals(bytes)).toBe(true);
    await expect(host.readFileBytes(file, 100)).rejects.toMatchObject({ code: "failed" });
    await expect(host.readFileBytes(`${root}/missing.svg`)).rejects.toMatchObject({ code: "not_found" });
  });

  it("round-trips UTF-8 contents and tricky filenames across all filesystem operations", async () => {
    const folder = `${root}/dir space'\n\\backslash`;
    const filename = "-file'\n$(touch INJECTED)\\中文.txt";
    const file = `${folder}/${filename}`;
    const contents = "first\n中文🦊\0last\r\n";
    await host.writeFile(file, contents);
    expect(await host.readFile(file)).toBe(contents);
    const st = await host.stat(file);
    expect(st).toMatchObject({ isFile: true, isDir: false, size: Buffer.byteLength(contents) });
    expect(st.mtimeMs).toBeGreaterThan(0);
    await host.mkdirp(`${folder}/.hidden-dir`);
    await host.writeFile(`${folder}/.hidden`, "");
    await fs.symlink("absent", `${folder}/broken-link`);
    await fs.symlink(".hidden-dir", `${folder}/directory-link`);
    expect(await host.listDir(folder)).toEqual([
      { name: ".hidden-dir", type: "dir" }, { name: "directory-link", type: "dir" },
      ...[{ name: filename, type: "file" }, { name: ".hidden", type: "file" }, { name: "broken-link", type: "file" }]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    ]);
    const copy = `${root}/copy\n'folder`;
    await host.copyPath(folder, copy);
    expect(await host.readFile(`${copy}/${filename}`)).toBe(contents);
    const renamed = `${root}/renamed'\nfolder`;
    await host.rename(copy, renamed);
    expect(await host.exists(copy)).toBe(false);
    expect(await host.exists(`${renamed}/${filename}`)).toBe(true);
    await host.remove(renamed); await host.remove(renamed);
    expect(await host.exists(renamed)).toBe(false);
    await expect(fs.stat(`${root}/INJECTED`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves ~/ and relative filenames against the remote home, preserving leading dashes", async () => {
    await host.writeFile("~/nested/new\nfile", "home");
    expect(await host.readFile("nested/new\nfile")).toBe("home");
    await host.writeFile("-dash", "dash");
    expect(await host.readFile("-dash")).toBe("dash");
    expect((await host.stat("-dash")).size).toBe(4);
    expect((await host.run("~", "pwd", [])).stdout).toBe(`${root}\n`);
    expect((await host.run("~/nested", "pwd", [])).stdout).toBe(`${root}/nested\n`);
  });

  it("bounds remote reads by bytes without corrupting UTF-8 or masking file errors", async () => {
    const file = `${root}/-preview '中文.txt`;
    const text = "abc中文🦊" + "x".repeat(1024 * 1024);
    await fs.writeFile(file, text);
    expect(await host.readFile(file, { maxBytes: 8 })).toBe("abc中");
    expect(await host.readFile(file, { maxBytes: 0 })).toBe("");
    expect(await host.readFile(file)).toBe(text);
    await expect(host.readFile(`${root}/missing`, { maxBytes: 8 })).rejects.toMatchObject({ code: "not_found" });
    expect(await host.readFile(file, { maxBytes: 13 })).toBe("abc中文🦊");
  });

  it("returns an empty directory listing without phantom glob entries", async () => {
    expect(await host.listDir(root)).toEqual([]);
  });

  it("maps missing paths and does not hide disconnected errors as nonexistence", async () => {
    await expect(host.readFile(`${root}/missing`)).rejects.toMatchObject({ code: "not_found" });
    await expect(host.listDir(`${root}/missing`)).rejects.toMatchObject({ code: "not_found" });
    expect(await host.exists(`${root}/missing`)).toBe(false);
    await host.dispose();
    await expect(host.exists(`${root}/missing`)).rejects.toMatchObject({ code: "disconnected" });
  });

  it("supports BSD stat when GNU format flags are unavailable", async () => {
    const bin = path.join(root, "bin"); await fs.mkdir(bin);
    const stat = path.join(bin, "stat");
    await fs.writeFile(stat, "#!/bin/sh\nif [ \"$2\" = '-c' ]; then exit 1; fi\nif [ \"$1\" = '-L' ] && [ \"$2\" = '-f' ] && [ \"$3\" = '%z|%m' ]; then printf '8|1700000000\\n'; else exit 2; fi\n", { mode: 0o755 });
    fixturePath = `${bin}:${fixturePath}`;
    await fs.writeFile(path.join(root, "data"), "12345678");
    expect(await host.stat("data")).toEqual({ isFile: true, isDir: false, size: 8, mtimeMs: 1700000000000 });
  });

  it("sends EOF when stdin is omitted and rejects NUL in command arguments", async () => {
    expect(await host.run(root, "cat", [], { timeoutMs: 1000 })).toEqual({ stdout: "", stderr: "", code: 0 });
    await expect(host.run(root, "printf", ["bad\0value"])).rejects.toMatchObject({ code: "failed" });
  });

  it.runIf(persistentReads)("serves repeated reads from one ssh process and falls back when it dies", async () => {
    await fs.mkdir(path.join(root, "a")); await fs.writeFile(path.join(root, "a", "f.txt"), "x");
    spawnMock.mockClear();
    for (let i = 0; i < 5; i++) {
      expect(await host.listDir(`${root}/a`)).toEqual([{ name: "f.txt", type: "file" }]);
      expect((await host.stat(`${root}/a/f.txt`)).size).toBe(1);
    }
    expect(await host.readFile(`${root}/a/f.txt`)).toBe("x");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Writes keep their own process (never replayed through the helper).
    await host.writeFile(`${root}/a/g.txt`, "y");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // Kill the helper's remote loop: the next read still succeeds.
    const helperChild = spawnMock.mock.results[0]!.value as import("node:child_process").ChildProcess;
    const closed = new Promise((done) => helperChild.once("close", done));
    helperChild.kill("SIGKILL");
    await closed;
    expect(await host.readFile(`${root}/a/g.txt`)).toBe("y");
  });
});
