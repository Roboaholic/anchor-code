import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  WSL_SEARCH_HELPER_PY,
  WslSearchHelperClient,
  buildWslExecArgs,
  buildWslGroupExecArgs,
  buildWslInstallScript,
  buildWslKillGroupArgs,
  parseWslInstallOutput,
  takePgidMarker,
  type HelperProcess,
} from "./wslSearchTools.js";

describe("wsl arg builders", () => {
  it("execs without a (login) shell", () => {
    const argv = buildWslExecArgs(["-d", "Ubuntu"], "/repo", "rg", ["-n", "--", "a b", "."]);
    expect(argv).toEqual(["-d", "Ubuntu", "--cd", "/repo", "--exec", "rg", "-n", "--", "a b", "."]);
    expect(argv).not.toContain("bash");
    expect(argv).not.toContain("-lc");
  });

  it("wraps in setsid + runner for process-group kill", () => {
    expect(
      buildWslGroupExecArgs([], "/r", "/home/u/.cache/anchor/run-group.sh", "rg", ["x"]),
    ).toEqual(["--cd", "/r", "--exec", "setsid", "-w", "/home/u/.cache/anchor/run-group.sh", "rg", "x"]);
    expect(buildWslKillGroupArgs(["-d", "D"], 42)).toEqual([
      "-d", "D", "--exec", "kill", "-TERM", "--", "-42",
    ]);
  });

  it("extracts and strips the PGID marker", () => {
    expect(takePgidMarker("__ANCHOR_PGID:123\nwarn")).toEqual({ pgid: 123, rest: "warn" });
    expect(takePgidMarker("nothing")).toEqual({ pgid: null, rest: "nothing" });
  });
});

describe("install script", () => {
  it("copies bundled rg once into ~/.cache/anchor and reports tools", () => {
    const script = buildWslInstallScript("/mnt/c/app/vendor/ripgrep-linux-x64/rg");
    expect(script).toContain('cp -f \'/mnt/c/app/vendor/ripgrep-linux-x64/rg\' "$D/rg.tmp"');
    expect(script).toContain("cmp -s");
    expect(script).not.toMatch(/bash -lc/);
    const tools = parseWslInstallOutput("HOME=/home/u\nRG=/home/u/.cache/anchor/rg\nPY=/usr/bin/python3\n");
    expect(tools).toEqual({
      home: "/home/u",
      rg: "/home/u/.cache/anchor/rg",
      runner: "/home/u/.cache/anchor/run-group.sh",
      helper: "/home/u/.cache/anchor/search-helper.py",
      python: "/usr/bin/python3",
    });
    expect(parseWslInstallOutput("HOME=/h\nRG=\nPY=\n")).toMatchObject({ rg: null, helper: null });
    expect(() => parseWslInstallOutput("garbage")).toThrow();
  });

  it("installs into a fake HOME with bash", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-home-"));
    const fakeRg = path.join(home, "rg-src");
    fs.writeFileSync(fakeRg, "#!/bin/sh\necho ripgrep 14\n");
    const out = execFileSync("bash", ["-s"], {
      input: buildWslInstallScript(fakeRg),
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const tools = parseWslInstallOutput(out);
    expect(tools.rg).toBe(path.join(home, ".cache/anchor/rg"));
    expect(fs.statSync(tools.rg!).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(tools.runner)).toBe(true);
  });
});

class FakeProc extends EventEmitter implements HelperProcess {
  written: string[] = [];
  stdout = new EventEmitter() as unknown as HelperProcess["stdout"] & EventEmitter;
  stdin = { write: (d: string) => this.written.push(d) };
  kill() {
    this.emit("exit", 0);
  }
  reply(obj: unknown) {
    (this.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
  }
  sent() {
    return this.written.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

describe("WslSearchHelperClient (mock protocol)", () => {
  it("runs, streams and resolves on exit", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    p.reply({ ev: "ready" });
    await c.ready;
    const chunks: string[] = [];
    const run = c.run("/r", "rg", ["x"], { onStdoutChunk: (ch) => chunks.push(ch) });
    expect(p.sent()[0]).toEqual({ op: "run", id: "r1", cwd: "/r", cmd: "rg", args: ["x"] });
    p.reply({ id: "r1", ev: "out", data: "a:1:x\n" });
    p.reply({ id: "r1", ev: "err", data: "warn" });
    p.reply({ id: "r1", ev: "exit", code: 0 });
    await expect(run).resolves.toEqual({ stdout: "a:1:x\n", stderr: "warn", code: 0 });
    expect(chunks).toEqual(["a:1:x\n"]);
  });

  it("forwards stdin to the helper run payload", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    p.reply({ ev: "ready" });
    await c.ready;
    const run = c.run("/r", "bash", ["-s"], { stdin: "echo hi\n" });
    expect(p.sent()[0]).toEqual({
      op: "run",
      id: "r1",
      cwd: "/r",
      cmd: "bash",
      args: ["-s"],
      stdin: "echo hi\n",
    });
    p.reply({ id: "r1", ev: "out", data: "hi\n" });
    p.reply({ id: "r1", ev: "exit", code: 0 });
    await expect(run).resolves.toEqual({ stdout: "hi\n", stderr: "", code: 0 });
  });

  it("handles JSON lines split across chunks with multi-byte UTF-8", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    const run = c.run("/", "rg", []);
    const buf = Buffer.from(`${JSON.stringify({ id: "r1", ev: "out", data: "中文" })}\n${JSON.stringify({ id: "r1", ev: "exit", code: 1 })}\n`);
    const cut = buf.indexOf(Buffer.from("中")) + 1; // split inside a code point
    (p.stdout as unknown as EventEmitter).emit("data", buf.subarray(0, cut));
    (p.stdout as unknown as EventEmitter).emit("data", buf.subarray(cut));
    await expect(run).resolves.toMatchObject({ stdout: "中文", code: 1 });
  });

  it("sends cancel on abort and on earlyExit", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    const ctl = new AbortController();
    const run = c.run("/", "rg", [], { signal: ctl.signal });
    p.reply({ id: "r1", ev: "out", data: "partial" });
    ctl.abort();
    await expect(run).resolves.toMatchObject({ aborted: true, stdout: "partial" });
    expect(p.sent().at(-1)).toEqual({ op: "cancel", id: "r1" });

    const run2 = c.run("/", "rg", [], { earlyExit: (out) => out.length > 2 });
    p.reply({ id: "r2", ev: "out", data: "abcd" });
    await expect(run2).resolves.toMatchObject({ earlyExit: true });
    expect(p.sent().at(-1)).toEqual({ op: "cancel", id: "r2" });
  });

  it("rejects pending runs when the helper dies (caller falls back)", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    const run = c.run("/", "rg", []);
    p.emit("exit", 1);
    await expect(run).rejects.toThrow(/exited/);
    expect(c.alive).toBe(false);
    await expect(c.run("/", "rg", [])).rejects.toThrow();
  });

  it("rejects readiness promptly if the helper exits before its greeting", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    p.emit("exit", 127);
    await expect(c.ready).rejects.toThrow(/before readiness/);
  });

  it("cancels a throwing early-exit callback and leaves other requests usable", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    const run = c.run("/", "rg", [], { earlyExit: () => { throw new Error("predicate failed"); } });
    p.reply({ id: "r1", ev: "out", data: "partial" });
    await expect(run).rejects.toThrow("predicate failed");
    expect(p.sent().at(-1)).toEqual({ op: "cancel", id: "r1" });
    const next = c.run("/", "rg", []);
    p.reply({ id: "r2", ev: "exit", code: 1 });
    await expect(next).resolves.toMatchObject({ code: 1 });
    c.dispose();
  });

  it("does not evaluate early-exit after an observer cancels the request", async () => {
    const p = new FakeProc();
    const c = new WslSearchHelperClient(p);
    const controller = new AbortController();
    const earlyExit = vi.fn();
    const run = c.run("/", "rg", [], { signal: controller.signal, onStdoutChunk: () => controller.abort(), earlyExit });
    p.reply({ id: "r1", ev: "out", data: "partial" });
    await expect(run).resolves.toMatchObject({ stdout: "partial", aborted: true });
    expect(earlyExit).not.toHaveBeenCalled();
    expect(p.sent().filter((msg) => msg.op === "cancel")).toHaveLength(1);
    c.dispose();
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

describe.skipIf(!hasPy)("search helper script (real python3, Linux)", () => {
  it("preserves UTF-8 paths, arguments, stdin and output under an ASCII remote locale", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-查询-"));
    const child = spawn("python3", ["-u", "-c", WSL_SEARCH_HELPER_PY], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", PYTHONIOENCODING: "ascii", PYTHONUTF8: "0", PYTHONCOERCECLOCALE: "0" },
    });
    const c = new WslSearchHelperClient(child);
    try {
      await c.ready;
      await expect(c.run(dir, "printf", ["%s", "查询🦊"])).resolves.toMatchObject({ stdout: "查询🦊", code: 0 });
      await expect(c.run(dir, "cat", [], { stdin: "中文\n" })).resolves.toMatchObject({ stdout: "中文\n", code: 0 });
      await expect(c.run(dir, "pwd", [])).resolves.toMatchObject({ stdout: `${dir}\n`, code: 0 });
    } finally {
      c.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams output and kills the whole process group on cancel", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-helper-"));
    const script = path.join(dir, "h.py");
    fs.writeFileSync(script, WSL_SEARCH_HELPER_PY);
    const child = spawn("python3", ["-u", script], { stdio: ["pipe", "pipe", "ignore"] });
    const c = new WslSearchHelperClient(child);
    try {
      await c.ready;
      const r = await c.run(dir, "sh", ["-c", "printf 'héllo\\n'; exit 3"]);
      expect(r).toMatchObject({ stdout: "héllo\n", code: 3 });

      const viaStdin = await c.run(dir, "bash", ["-s"], { stdin: "printf 'from-stdin\\n'" });
      expect(viaStdin).toMatchObject({ stdout: "from-stdin\n", code: 0 });

      const pidFile = path.join(dir, "pid");
      const ctl = new AbortController();
      const long = c.run(dir, "sh", ["-c", `sleep 30 & echo $! > ${pidFile}; echo started; wait`], {
        signal: ctl.signal,
        onStdoutChunk: () => ctl.abort(),
      });
      await expect(long).resolves.toMatchObject({ aborted: true });
      const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
      await new Promise((res) => setTimeout(res, 300));
      let alive = true;
      try {
        process.kill(grandchild, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      c.dispose();
    }
  });
});
