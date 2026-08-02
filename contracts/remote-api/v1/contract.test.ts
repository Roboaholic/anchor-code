import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  REMOTE_API_MAJOR,
  REMOTE_CAPABILITIES,
  REMOTE_MIN_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_V1_PATHS,
} from "./index.js";

describe("Remote API v1 contract", () => {
  it("keeps version metadata coherent", () => {
    expect(REMOTE_API_MAJOR).toBe(1);
    expect(REMOTE_PROTOCOL_VERSION).toMatch(/^1\./);
    expect(REMOTE_MIN_PROTOCOL_VERSION).toMatch(/^1\./);
    expect(new Set(REMOTE_CAPABILITIES).size).toBe(REMOTE_CAPABILITIES.length);
  });

  it("keeps the published OpenAPI path set complete", () => {
    const document = parse(fs.readFileSync(
      path.join(process.cwd(), "contracts/remote-api/v1/openapi.yaml"),
      "utf8",
    )) as { paths?: Record<string, unknown> };
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([...REMOTE_V1_PATHS].sort());
  });

  it("remains additive relative to the released v1 baseline", () => {
    const baseline = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "contracts/remote-api/fixtures/v1-baseline.json"),
      "utf8",
    )) as {
      protocolMajor: number;
      requiredCapabilities: string[];
      requiredPaths: string[];
    };
    expect(REMOTE_API_MAJOR).toBe(baseline.protocolMajor);
    expect(REMOTE_CAPABILITIES).toEqual(expect.arrayContaining(baseline.requiredCapabilities));
    expect(REMOTE_V1_PATHS).toEqual(expect.arrayContaining(baseline.requiredPaths));
  });

  it("advertises capabilities required by mobile", () => {
    expect(REMOTE_CAPABILITIES).toEqual(expect.arrayContaining([
      "workspace.select",
      "agent.session-sync",
      "terminal.snapshot-seq",
      "terminal.long-poll-events",
      "workspace.events",
      "system.instance-recovery",
    ]));
  });
});
