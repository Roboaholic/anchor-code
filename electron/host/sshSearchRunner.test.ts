import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSshSearchRunner } from "./sshSearchRunner.js";
import { scheduleSshCommand } from "./openSshScheduler.js";
import { HostError, type RunOptions, type RunResult } from "./types.js";
import { WSL_SEARCH_HELPER_PY } from "./wslSearchTools.js";

class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly sent: Array<{ op: string; id: string; cmd?: string }> = [];
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (data: string) => { this.sent.push(JSON.parse(data)); return true; },
  });
  killed = false;
  reply(message: unknown) { this.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`)); }
  exit(code: number) { this.emit("exit", code); this.emit("close", code); }
  kill() { if (!this.killed) { this.killed = true; this.exit(0); } }
  asChild() { return this as unknown as ChildProcess; }
}

const runners: OpenSshSearchRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose(); });

function setup(options: { autoReady?: boolean; exit?: number; readyTimeoutMs?: number } = {}) {
  const processes: FakeProcess[] = [];
  const fallback = vi.fn(async () => ({ stdout: "fallback\n", stderr: "", code: 0 }));
  const spawnHelper = vi.fn(() => {
    const child = new FakeProcess();
    processes.push(child);
    queueMicrotask(() => {
      if (options.exit !== undefined) child.exit(options.exit);
      else if (options.autoReady !== false) child.reply({ ev: "ready" });
    });
    return child.asChild();
  });
  const alias = `search-test-${Math.random()}`;
  const runner = new OpenSshSearchRunner({
    alias, spawn: spawnHelper, fallback,
    connectionError: () => new HostError("permission", "Host key verification failed"),
    readyTimeoutMs: options.readyTimeoutMs,
  });
  runners.push(runner);
  return { runner, alias, processes, fallback, spawnHelper };
}

async function request(processes: FakeProcess[], index = 0) {
  await vi.waitFor(() => expect(processes[0]?.sent.filter((m) => m.op === "run").length).toBeGreaterThan(index));
  return processes[0]!.sent.filter((m) => m.op === "run")[index]!;
}

describe("OpenSSH persistent search lifecycle", () => {
  it("shares startup and isolates concurrent requests on one connection", async () => {
    const { runner, processes, fallback, spawnHelper } = setup();
    const first = runner.run("/r", "rg", ["one"]);
    const second = runner.run("/r", "git", ["status"]);
    const a = await request(processes);
    const b = await request(processes, 1);
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    processes[0]!.reply({ id: b.id, ev: "out", data: "second" });
    processes[0]!.reply({ id: a.id, ev: "out", data: "first" });
    processes[0]!.reply({ id: a.id, ev: "exit", code: 0 });
    processes[0]!.reply({ id: b.id, ev: "exit", code: 1 });
    await expect(first).resolves.toMatchObject({ stdout: "first", code: 0 });
    await expect(second).resolves.toMatchObject({ stdout: "second", code: 1 });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back without repeated startup attempts when python3 is unavailable", async () => {
    const { runner, spawnHelper, fallback } = setup({ exit: 98 });
    await expect(runner.run("/r", "rg", ["one"])).resolves.toMatchObject({ stdout: "fallback\n" });
    await expect(runner.run("/r", "rg", ["two"])).resolves.toMatchObject({ stdout: "fallback\n" });
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("propagates host-key/authentication errors without replaying the command", async () => {
    const { runner, fallback } = setup({ exit: 255 });
    await expect(runner.run("/r", "rg", ["x"])).rejects.toThrow("Host key verification failed");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("never replays a failed helper command after streamed output", async () => {
    const { runner, processes, fallback } = setup();
    const chunks: string[] = [];
    const result = runner.run("/r", "rg", ["x"], { onStdoutChunk: (chunk) => chunks.push(chunk) });
    const rejected = expect(result).rejects.toThrow(/helper exited/i);
    const run = await request(processes);
    processes[0]!.reply({ id: run.id, ev: "out", data: "a.ts:1:x\n" });
    processes[0]!.exit(1);
    await rejected;
    expect(chunks).toEqual(["a.ts:1:x\n"]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("can safely fall back when the helper fails before producing output", async () => {
    const { runner, processes, fallback } = setup();
    const result = runner.run("/r", "rg", ["x"]);
    await request(processes);
    processes[0]!.exit(1);
    await expect(result).resolves.toMatchObject({ stdout: "fallback\n" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("cancels a query promptly while the shared connection is still starting", async () => {
    const { runner, processes, fallback } = setup({ autoReady: false });
    const controller = new AbortController();
    const result = runner.run("/r", "rg", ["x"], { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toMatchObject({ aborted: true });
    processes[0]!.reply({ ev: "ready" });
    await Promise.resolve();
    expect(processes[0]!.sent).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("includes connection startup in the caller's timeout", async () => {
    const { runner, fallback } = setup({ autoReady: false });
    await expect(runner.run("/r", "rg", ["x"], { timeoutMs: 15 })).rejects.toMatchObject({ code: "timeout" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("times out running commands and tells the helper to kill their process groups", async () => {
    const { runner, processes, fallback } = setup();
    const result = runner.run("/r", "rg", ["x"], { timeoutMs: 100 });
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    const run = await request(processes);
    await rejected;
    expect(processes[0]!.sent).toContainEqual({ op: "cancel", id: run.id });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("disposes a queued startup without later opening an SSH connection", async () => {
    const { runner, alias, spawnHelper, fallback } = setup();
    const releases: Array<() => void> = [];
    const fail = (error: unknown) => { throw error; };
    scheduleSshCommand(alias, (release) => releases.push(release), fail);
    scheduleSshCommand(alias, (release) => releases.push(release), fail);
    try {
      const result = runner.run("/r", "rg", ["x"]);
      const rejected = expect(result).rejects.toMatchObject({ code: "disconnected" });
      runner.dispose();
      await rejected;
    } finally {
      for (const release of releases) release();
    }
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not fall back after closing the workspace's helper", async () => {
    const { runner, processes, fallback } = setup();
    const result = runner.run("/r", "rg", ["x"]);
    const rejected = expect(result).rejects.toMatchObject({ code: "disconnected" });
    await request(processes);
    runner.disposeHelper();
    await rejected;
    expect(fallback).not.toHaveBeenCalled();
  });

  it("aborts an in-flight fallback when the workspace closes and drops late output", async () => {
    const child = new FakeProcess();
    let fallbackOptions: RunOptions | undefined;
    let finishFallback!: (result: RunResult) => void;
    const fallback = vi.fn((_cwd: string, _command: string, _args: string[], opts: RunOptions) => {
      fallbackOptions = opts;
      return new Promise<RunResult>((resolve) => { finishFallback = resolve; });
    });
    const runner = new OpenSshSearchRunner({
      alias: "fallback-disposal", fallback,
      spawn: () => { queueMicrotask(() => child.exit(98)); return child.asChild(); },
      connectionError: (message) => new HostError("failed", message),
    });
    runners.push(runner);
    const chunks = vi.fn();
    const result = runner.run("/r", "rg", ["x"], { onStdoutChunk: chunks });
    const rejected = expect(result).rejects.toMatchObject({ code: "disconnected" });
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledOnce());
    runner.disposeHelper();
    await rejected;
    expect(fallbackOptions?.signal?.aborted).toBe(true);
    fallbackOptions?.onStdoutChunk?.("late", "late");
    finishFallback({ stdout: "late", stderr: "", code: 0 });
    expect(chunks).not.toHaveBeenCalled();
  });
});

const hasPy = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return process.platform !== "win32";
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPy)("persistent search helper on a real POSIX process", () => {
  it("reuses one helper for Unicode, stdin and repeated commands", async () => {
    const spawnHelper = vi.fn(() => spawn("python3", ["-u", "-c", WSL_SEARCH_HELPER_PY], { stdio: ["pipe", "pipe", "pipe"] }));
    const fallback = vi.fn(async () => { throw new Error("Unexpected fallback"); });
    const runner = new OpenSshSearchRunner({ alias: "real-search-reuse", spawn: spawnHelper, fallback, connectionError: (message) => new HostError("failed", message) });
    runners.push(runner);
    for (let index = 0; index < 3; index++) {
      await expect(runner.run("/tmp", "bash", ["-s"], { stdin: `printf '查询 ${index}\\n'` })).resolves.toMatchObject({ stdout: `查询 ${index}\n`, code: 0 });
    }
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("kills TERM-resistant work on cancel and keeps the helper usable", async () => {
    const child = spawn("python3", ["-u", "-c", WSL_SEARCH_HELPER_PY], { stdio: ["pipe", "pipe", "pipe"] });
    const runner = new OpenSshSearchRunner({
      alias: "real-search-cancel", spawn: () => child,
      fallback: async () => { throw new Error("Unexpected fallback"); },
      connectionError: (message) => new HostError("failed", message),
    });
    runners.push(runner);
    const controller = new AbortController();
    let pid = 0;
    const result = await runner.run("/tmp", "bash", ["-c", "trap '' TERM; echo $$; while :; do sleep 1; done"], {
      signal: controller.signal,
      onStdoutChunk: (chunk) => { pid = Number(chunk.trim()); controller.abort(); },
    });
    expect(result.aborted).toBe(true);
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
    await expect(runner.run("/tmp", "printf", ["still-usable"])).resolves.toMatchObject({ stdout: "still-usable", code: 0 });
  });
});
