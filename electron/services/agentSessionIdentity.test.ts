import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_CAPTURE_TIMEOUT_MS,
  AGENT_SESSION_SCAN_TIMEOUT_MS,
  AGENT_SESSION_WORKSPACE_SCAN_WINDOW,
  claimCreatedAgentSession,
  geminiProjectHash,
  isPathWithin,
  parseAgentSessionCwd,
  sessionScanNeedles,
  parseAgentSessionTitle,
  listAgentSessions,
  parseAgentSessionList,
  sessionIdsFromPaths,
  sessionIdsFromFileNames,
  waitForCreatedAgentSession,
  sessionIdPattern,
} from "./agentSessionIdentity.js";

const id = "019fcfcf-7cc7-7000-b2c7-4f6a227815f3";

function extract(profileId: string, text: string): string[] {
  const pattern = sessionIdPattern(profileId);
  return pattern ? [...text.matchAll(pattern)].map((match) => match[1]!) : [];
}

describe("agent session identity", () => {
  it("extracts provider-owned IDs from session metadata", () => {
    expect(extract("omp", `{"type":"session","version":3,"id":"${id}"}`)).toEqual([id]);
    expect(extract("codex", `{"type":"session_meta","payload":{"session_id":"${id}"}}`)).toEqual([id]);
    expect(extract("claude", `{"sessionId":"${id}","cwd":"/workspace"}`)).toEqual([id]);
    expect(extract("gemini", `{"sessionId":"${id}","projectHash":"abc"}`)).toEqual([id]);
  });

  it("extracts OMP titles and falls back to the first user message", () => {
    expect(parseAgentSessionTitle("omp", `{"type":"title","title":"Write NN segmentation script","source":"auto"}`)).toBe("Write NN segmentation script");
    expect(parseAgentSessionTitle("codex", `{"type":"session_meta","payload":{"session_id":"${id}"}}\n{"type":"message","payload":{"type":"message","role":"user","content":[{"type":"text","text":"Fix the login flow"}]}}`)).toBe("Fix the login flow");
  });

  it("extracts session ids from file paths without reading transcripts", () => {
    const second = "019fcfcf-7cc7-7000-b2c7-4f6a227816f4";
    expect([
      ...sessionIdsFromPaths([
        `/home/user/.omp/agent/sessions/repo/2026-08-07_${id}.jsonl`,
        `/home/user/.omp/agent/sessions/repo/2026-08-07_${second}.jsonl`,
      ].join("\n")),
    ]).toEqual([id, second]);
  });

  it("lists recent sessions with titles and timestamps", () => {
    const text = [
      `\x1e1700000000\t/home/user/.omp/agent/sessions/repo/a_${id}.jsonl\n`,
      `{"type":"session","id":"${id}"}\n`,
      '{"type":"title","title":"Resume image paste"}\n',
      "\x1f\n",
    ].join("");
    expect(parseAgentSessionList("omp", text)).toEqual([{
      id,
      title: "Resume image paste",
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    }]);
  });

  it("loads WSL sessions with one host command", async () => {
    const run = vi.fn(async () => ({
      stdout: [
        `\x1e1700000000\t/home/user/.omp/agent/sessions/repo/a_${id}.jsonl\n`,
        `{"type":"session","id":"${id}"}\n`,
        '{"type":"title","title":"One command"}\n',
        "\x1f\n",
      ].join(""),
      stderr: "",
      code: 0,
    }));
    const host = {
      kind: "wsl",
      workspaceRoot: "/workspace",
      run,
    } as never;

    await expect(listAgentSessions(host, "omp", 12)).resolves.toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "/",
      "bash",
      ["-s"],
      expect.objectContaining({
        stdin: expect.stringContaining("$HOME/.omp/agent/sessions"),
        timeoutMs: AGENT_SESSION_SCAN_TIMEOUT_MS,
      }),
    );
  });

  it("keeps session listing bounded at eight seconds", () => {
    expect(AGENT_SESSION_SCAN_TIMEOUT_MS).toBe(8_000);
  });


  it("claims each newly discovered session at most once", () => {
    const before = new Set([id]);
    const claimed = new Set<string>();
    const claim = (value: string) => {
      if (claimed.has(value)) return false;
      claimed.add(value);
      return true;
    };
    const current = new Set([id, "019fcfcf-7cc7-7000-b2c7-4f6a227816f4"]);
    expect(claimCreatedAgentSession(current, before, claim)).toBe(
      "019fcfcf-7cc7-7000-b2c7-4f6a227816f4",
    );
    expect(claimCreatedAgentSession(current, before, claim)).toBeNull();
  });
  it("uses a five-minute default capture window", () => {
    expect(AGENT_SESSION_CAPTURE_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it("rejects unsupported profiles and unrelated UUIDs", () => {
    expect(sessionIdPattern("custom")).toBeNull();
    expect(extract("codex", `{"turn_id":"${id}"}`)).toEqual([]);
  });
});

describe("robust session id capture", () => {
  const fresh = "11111111-2222-4333-8444-555555555555";
  const old = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("reads ids from transcript file names only", () => {
    expect([...sessionIdsFromFileNames([
      `/h/.claude/projects/-repo/${fresh}.jsonl`,
      `/h/.codex/sessions/2026/10/14/rollout-2026-10-14T07-00-00-${old.toUpperCase()}.jsonl`,
      `/h/.claude/projects/-repo/${old}/subagents/agent-1.jsonl`,
    ].join("\n"))]).toEqual([fresh, old]);
  });

  it("matches newer codex session_meta ids", () => {
    const pattern = sessionIdPattern("codex")!;
    const m = [...`{"type":"session_meta","payload":{"id":"${fresh}","cwd":"/r"}}`.matchAll(pattern)][0]!;
    expect(m[1] ?? m[2]).toBe(fresh);
  });

  it("retries after a scan failure and claims the transcript created after launch", async () => {
    let recentCalls = 0;
    const run = vi.fn(async (_cwd: string, _cmd: string, args: string[], opts?: { stdin?: string }) => {
      const script = [...args, opts?.stdin ?? ""].join(" ");
      if (script.includes("-mmin")) {
        recentCalls += 1;
        if (recentCalls === 1) throw new Error("scan timed out");
        return { stdout: `/home/u/.claude/projects/-repo/${old}.jsonl\n/home/u/.claude/projects/-repo/${fresh}.jsonl\n`, stderr: "", code: 0 };
      }
      if (script.includes("HOME") || script.includes("echo")) return { stdout: "/home/u\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const host = { id: "local", kind: "local", run } as never;
    const id = await waitForCreatedAgentSession(host, "claude", new Set([old]), 10_000, undefined, Date.now());
    expect(id).toBe(fresh);
    expect(recentCalls).toBe(2);
  }, 15_000);
});

describe("pi sessions", () => {
  const pid = "01a1398f-d412-7775-ad78-3580c8d7e8e9";
  it("captures ids from pi file names and session headers, and reads names", () => {
    expect([...sessionIdsFromFileNames(`/h/.pi/agent/sessions/--tmp--/2026-10-14T08-38-09-682Z_${pid}.jsonl`)]).toEqual([pid]);
    const m = [...`{"type":"session","version":3,"id":"${pid}","cwd":"/tmp"}`.matchAll(sessionIdPattern("pi")!)][0]!;
    expect(m[1]).toBe(pid);
    expect(parseAgentSessionTitle("pi", [
      `{"type":"session","version":3,"id":"${pid}"}`,
      `{"type":"message","id":"a","message":{"role":"user","content":[{"type":"text","text":"Explain the limiter"}]}}`,
    ].join("\n"))).toBe("Explain the limiter");
    expect(parseAgentSessionTitle("pi", `{"type":"session_info","id":"b","name":"Limiter review"}`)).toBe("Limiter review");
  });
});

describe("workspace-scoped session history", () => {
  const a = "11111111-2222-4333-8444-555555555555";
  const b = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const c = "99999999-8888-4777-8666-555555555555";
  const rec = (file: string, lines: string[], mtime = 1_700_000_000) =>
    `\x1e${mtime}\t${file}\n${lines.join("\n")}\n\x1f\n`;

  it("reads cwd from codex, claude, pi/omp and legacy codex transcripts", () => {
    expect(parseAgentSessionCwd(`{"type":"session_meta","payload":{"id":"${a}","cwd":"/repo"}}`)).toBe("/repo");
    expect(parseAgentSessionCwd([
      `{"type":"summary","summary":"x"}`,
      `{"type":"user","sessionId":"${a}","cwd":"/repo/pkg","message":{"role":"user","content":"hi"}}`,
    ].join("\n"))).toBe("/repo/pkg");
    expect(parseAgentSessionCwd(`{"type":"session","version":3,"id":"${a}","cwd":"/tmp"}`)).toBe("/tmp");
    expect(parseAgentSessionCwd(
      `{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\\n  <cwd>C:\\\\code\\\\repo</cwd>\\n</environment_context>"}]}`,
    )).toBe("C:\\code\\repo");
    expect(parseAgentSessionCwd(`{"sessionId":"${a}","projectHash":"abc"}`)).toBeNull();
  });

  it("matches the workspace root and its subdirectories only", () => {
    expect(isPathWithin("/repo", "/repo")).toBe(true);
    expect(isPathWithin("/repo/src/", "/repo/")).toBe(true);
    expect(isPathWithin("/repo2", "/repo")).toBe(false);
    expect(isPathWithin("/", "/repo")).toBe(false);
    expect(isPathWithin("/anything", "/")).toBe(true);
    expect(isPathWithin("c:\\Code\\Repo\\sub", "C:\\code\\repo")).toBe(true);
    expect(isPathWithin("/Users/me/Repo", "/Users/me/repo")).toBe(false);
    expect(isPathWithin("/Users/me/Repo", "/Users/me/repo", true)).toBe(true);
  });

  it("filters listed sessions by cwd and drops sessions without metadata", () => {
    const text = [
      rec(`/h/.codex/sessions/2026/10/21/rollout-x-${a}.jsonl`, [`{"type":"session_meta","payload":{"id":"${a}","cwd":"/repo/app"}}`]),
      rec(`/h/.codex/sessions/2026/10/21/rollout-x-${b}.jsonl`, [`{"type":"session_meta","payload":{"id":"${b}","cwd":"/repo2"}}`]),
      rec(`/h/.codex/sessions/2026/10/21/rollout-x-${c}.jsonl`, [`{"type":"session_meta","payload":{"id":"${c}"}}`]),
    ].join("");
    const scoped = parseAgentSessionList("codex", text, { root: "/repo" });
    expect(scoped.map((s) => [s.id, s.cwd])).toEqual([[a, "/repo/app"]]);
    expect(parseAgentSessionList("codex", text)).toHaveLength(3);
  });

  it("matches gemini sessions by project hash", () => {
    const hash = geminiProjectHash("/repo");
    const text = [
      rec(`/h/.gemini/tmp/${hash}/chats/${a}.jsonl`, [`{"sessionId":"${a}","projectHash":"${hash}"}`]),
      rec(`/h/.gemini/tmp/${"0".repeat(64)}/chats/${b}.jsonl`, [`{"sessionId":"${b}","projectHash":"${"0".repeat(64)}"}`]),
    ].join("");
    expect(parseAgentSessionList("gemini", text, { root: "/repo" }).map((s) => s.id)).toEqual([a]);
  });

  it("scans with the workspace prefilter on WSL/SSH and trims to the limit", async () => {
    const run = vi.fn(async () => ({
      stdout: [
        rec(`/home/u/.omp/agent/sessions/--home-u-repo--/x_${a}.jsonl`, [`{"type":"session","id":"${a}","cwd":"/home/u/repo"}`]),
        rec(`/home/u/.omp/agent/sessions/--home-u-repo2--/x_${b}.jsonl`, [`{"type":"session","id":"${b}","cwd":"/home/u/repo2"}`]),
      ].join(""),
      stderr: "",
      code: 0,
    }));
    const host = { kind: "ssh", workspaceRoot: "/home/u/repo", run } as never;
    const sessions = await listAgentSessions(host, "omp", 1, { workspaceRoot: "/home/u/repo" });
    expect(sessions.map((s) => s.id)).toEqual([a]);
    const script = (run.mock.calls[0] as unknown as [string, string, string[], { stdin: string }])[3].stdin;
    expect(script).toContain(`head -n ${AGENT_SESSION_WORKSPACE_SCAN_WINDOW}`);
    expect(script).toContain("grep -qF -e '/home/u/repo'");
    expect(sessionScanNeedles("omp", "/home/u/repo/")).toEqual(["/home/u/repo"]);
  });
});
