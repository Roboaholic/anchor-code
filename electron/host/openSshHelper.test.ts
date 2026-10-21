import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { HELPER_SCRIPT, OpenSshHelperClient, READY_MARKER, type HelperProcess } from "./openSshHelper";
import { HostError } from "./types";

const clients: OpenSshHelperClient[] = [];
function localHelper(prefix = ""): OpenSshHelperClient {
  // Same script the remote side runs, with optional login noise first.
  const child = spawn("bash", ["-c", `${prefix}${HELPER_SCRIPT}`], { stdio: ["pipe", "pipe", "pipe"] });
  const client = new OpenSshHelperClient(child);
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

describe.skipIf(process.platform === "win32")("OpenSshHelperClient with the real bash loop", () => {
  it("answers pipelined requests in order with exact stdout/stderr/exit codes", async () => {
    const h = localHelper("echo motd-noise; ");
    await h.whenReady();
    const results = await Promise.all([
      h.exec("printf 'a\\0b\\n'"),
      h.exec("echo out; echo err >&2; exit 3"),
      h.exec("printf '%s' 'héllo ✓'"),
      h.exec("cd /; pwd"),
      h.exec("pwd"),
    ]);
    expect(results[0]).toEqual({ stdout: "a\0b\n", stderr: "", code: 0 });
    expect(results[1]).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
    expect(results[2].stdout).toBe("héllo ✓");
    expect(results[3].stdout).toBe("/\n");
    // Each script runs in its own subshell: cd does not leak.
    expect(results[4].stdout).toBe(`${process.env.HOME}\n`);
  });

  it("handles multibyte scripts, quotes and large outputs", async () => {
    const h = localHelper();
    const name = "dir with 'quote' & ünïcode";
    const r = await h.exec(`printf '%s' '${name.replace(/'/g, `'\\''`)}'`);
    expect(r.stdout).toBe(name);
    const big = await h.exec("head -c 1048576 /dev/zero | tr '\\0' x");
    expect(big.stdout.length).toBe(1_048_576);
    expect(big.code).toBe(0);
    expect((await h.exec("echo after")).stdout).toBe("after\n");
  });

  it("rejects pending and later requests once the remote loop exits", async () => {
    const h = localHelper();
    await h.whenReady();
    const killed = h.exec("kill -TERM $$; sleep 5");
    await expect(killed).rejects.toBeInstanceOf(HostError);
    expect(h.alive).toBe(false);
    await expect(h.exec("true")).rejects.toBeInstanceOf(HostError);
  });

  it("fails readiness when the remote shell exits before the loop starts", async () => {
    const h = localHelper("exit 98; ");
    await expect(h.whenReady()).rejects.toBeInstanceOf(HostError);
  });
});

describe("OpenSshHelperClient protocol", () => {
  function fakeChild() {
    const ev = new EventEmitter();
    const child = Object.assign(ev, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => { ev.emit("close", null); return true; },
    });
    return child as unknown as HelperProcess & { stdout: PassThrough; stdin: PassThrough };
  }

  it("parses responses split across arbitrary chunks and padded byte counts", async () => {
    const child = fakeChild();
    const h = new OpenSshHelperClient(child);
    const p = h.exec("x");
    // Byte-at-a-time delivery with wc-style space padding.
    const exact = Buffer.concat([Buffer.from(`noise\n${READY_MARKER}\n1 0      5       2\n`), Buffer.from("hello"), Buffer.from("e!")]);
    for (const b of exact) child.stdout.write(Buffer.from([b]));
    await expect(p).resolves.toEqual({ stdout: "hello", stderr: "e!", code: 0 });
  });

  it("times out a stuck request and tears the session down", async () => {
    const child = fakeChild();
    const h = new OpenSshHelperClient(child);
    child.stdout.write(`${READY_MARKER}\n`);
    await h.whenReady();
    await expect(h.exec("sleep", 20)).rejects.toMatchObject({ code: "timeout" });
    expect(h.alive).toBe(false);
  });

  it("refuses scripts containing NUL", async () => {
    const h = new OpenSshHelperClient(fakeChild());
    await expect(h.exec("a\0b")).rejects.toBeInstanceOf(HostError);
  });
});
