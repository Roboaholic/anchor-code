import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSession, RunOptions, RunResult } from "../host/types.js";
import { loadLog } from "./historyService.js";

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

function revParse(cwd: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

const logLine = (
  hash: string,
  subject: string,
) => `${hash}\t${hash.slice(0, 7)}\t${subject}\tTest\t2026-01-01T00:00:00Z`;

describe("loadLog incremental since (main process)", () => {
  it("parses a combined ssh script that signals reset", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({
      stdout: [
        "__AC_RESET__\t1",
        logLine("8f55a3415fab15fb6cd488b6f1cf51c05068a2bf", "squashed"),
        logLine("a30be3412572be83fc4baec6072d5c7139c55ddb", "base"),
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    }));
    const host = { kind: "ssh", run } as unknown as HostSession;
    const result = await loadLog(host, "/data/repo", {
      since: "81784e9aaaaaaaabbbbbbbbbccccccccdddddddd",
      limit: 50,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const call = run.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      RunOptions?,
    ];
    expect(call[1]).toBe("bash");
    expect(call[2]).toEqual(["-s"]);
    expect(call[3]?.stdin).toContain("merge-base --is-ancestor");
    expect(call[3]?.stdin).toContain("81784e9aaaaaaaabbbbbbbbbccccccccdddddddd");
    expect(result.reset).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(result.commits.map((c) => c.shortHash)).toEqual(["8f55a34", "a30be34"]);
  });

  it("parses a combined ssh script that prepends when since is an ancestor", async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({
      stdout: [
        "__AC_RESET__\t0",
        logLine("8f55a3415fab15fb6cd488b6f1cf51c05068a2bf", "new tip"),
        "",
      ].join("\n"),
      stderr: "",
      code: 0,
    }));
    const host = { kind: "wsl", run } as unknown as HostSession;
    const result = await loadLog(host, "/r", {
      since: "a30be3412572be83fc4baec6072d5c7139c55ddb",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.reset).toBeUndefined();
    expect(result.hasMore).toBe(false);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]?.hash).toBe(
      "8f55a3415fab15fb6cd488b6f1cf51c05068a2bf",
    );
  });
});

describe("loadLog incremental since on ssh (local bash)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-hist-ssh-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(root, "app.ts"), "export const n = 1\n", "utf8");
    git(root, ["add", "app.ts"]);
    git(root, ["commit", "-m", "first"]);
    await fs.writeFile(path.join(root, "app.ts"), "export const n = 2\n", "utf8");
    git(root, ["add", "app.ts"]);
    git(root, ["commit", "-m", "second"]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function sshHost() {
    const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const host = {
      kind: "ssh" as const,
      async run(
        _cwd: string,
        command: string,
        args: string[],
        opts?: RunOptions,
      ): Promise<RunResult> {
        calls.push({ command, args, stdin: opts?.stdin });
        try {
          const stdout = execFileSync(command, args, {
            cwd: root,
            input: opts?.stdin,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout, stderr: "", code: 0 };
        } catch (err) {
          const failed = err as { stdout?: string; stderr?: string; status?: number };
          return {
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? "",
            code: failed.status ?? 1,
          };
        }
      },
    } as unknown as HostSession;
    return { host, calls };
  }

  it("uses one bash command and resets after a squash rewrite", async () => {
    const oldTip = revParse(root);
    const first = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    git(root, ["reset", "--soft", first]);
    git(root, ["commit", "-m", "squashed"]);
    const newHead = revParse(root);

    const { host, calls } = sshHost();
    const result = await loadLog(host, root, { since: oldTip, limit: 50 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("bash");
    expect(calls[0]?.args).toEqual(["-s"]);
    expect(result.reset).toBe(true);
    expect(result.commits.map((c) => c.hash)).toEqual([newHead, first]);
    expect(result.commits.some((c) => c.hash === oldTip)).toBe(false);
  });

  it("uses one bash command and returns only newer commits when since is an ancestor", async () => {
    const head = revParse(root);
    const first = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const { host, calls } = sshHost();
    const result = await loadLog(host, root, { since: first });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("bash");
    expect(result.reset).toBeFalsy();
    expect(result.commits.map((c) => c.hash)).toEqual([head]);
  });
});
