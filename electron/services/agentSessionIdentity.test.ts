import { describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_CAPTURE_TIMEOUT_MS,
  claimCreatedAgentSession,
  parseAgentSessionTitle,
  listAgentSessions,
  parseAgentSessionList,
  sessionIdsFromPaths,
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
      "/workspace",
      "bash",
      ["-s"],
      expect.objectContaining({ stdin: expect.stringContaining("$HOME/.omp/agent/sessions") }),
    );
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
