import { describe, expect, it } from "vitest";
import { AGENT_SESSION_CAPTURE_TIMEOUT_MS, parseAgentSessionTitle, sessionIdPattern } from "./agentSessionIdentity.js";

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

  it("uses a five-minute default capture window", () => {
    expect(AGENT_SESSION_CAPTURE_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it("rejects unsupported profiles and unrelated UUIDs", () => {
    expect(sessionIdPattern("custom")).toBeNull();
    expect(extract("codex", `{"turn_id":"${id}"}`)).toEqual([]);
  });
});
