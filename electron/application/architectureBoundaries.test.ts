import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("application architecture boundaries", () => {
  it("keeps the relay adapter dependent on application facades", () => {
    const source = fs.readFileSync(
      path.join(root, "electron/remote/relayConnector.ts"),
      "utf8",
    );
    expect(source).toContain("../application/remoteRequestHandler.js");
    expect(source).not.toMatch(/from "\.\.\/services\/(annotationsService|historyService|fileIndex|contentSearch|agentCli|agentLaunch)\.js"/);
    expect(source).not.toContain("../host/hostManager.js");
    expect(source).not.toContain("../services/terminalService.js");
  });

  it("never wires the Anchor Relay into the desktop app", () => {
    const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
    const main = read("electron/main.ts");
    const ipc = read("electron/ipc/register.ts");
    const preload = read("electron/preload.ts");
    const api = read("src/shared/anchor-api.ts");
    for (const source of [main, ipc, preload]) {
      expect(source).not.toContain("relayConnector");
      expect(source).not.toContain("RelayConnector");
      expect(source).not.toMatch(/\brelay\.start\(/);
      expect(source).not.toContain('"remote:');
      expect(source).not.toContain("getRemoteAccessConfig");
    }
    expect(main).not.toContain("RemoteRequestHandler");
    expect(api).not.toContain("RemoteAccessInfo");
  });

  it("does not expose a direct HTTP mobile adapter", () => {
    expect(fs.existsSync(path.join(root, "electron/remote/remoteServer.ts"))).toBe(false);
    const source = fs.readFileSync(path.join(root, "mobile/web/src/api.ts"), "utf8");
    expect(source).not.toContain("DirectHttpTransport");
  });

  it("keeps every static remote route represented by OpenAPI", () => {
    const source = fs.readFileSync(
      path.join(root, "electron/application/remoteRequestHandler.ts"),
      "utf8",
    );
    const openapi = fs.readFileSync(
      path.join(root, "contracts/remote-api/v1/openapi.yaml"),
      "utf8",
    );
    const implemented = [...source.matchAll(/path === "\/api\/v1([^"?]+)"/g)]
      .map((match) => match[1]);
    for (const route of implemented) {
      expect(openapi, `OpenAPI missing ${route}`).toContain(`  ${route}:`);
    }
    expect(openapi).toContain("  /comments/{commentId}:");
    expect(openapi).toContain("  /terminals/{terminalId}:");
  });

  it("keeps mobile UI free of transport paths", () => {
    const source = fs.readFileSync(
      path.join(root, "mobile/web/src/App.tsx"),
      "utf8",
    );
    expect(source).not.toContain("/api/v1");
    expect(source).toContain("AnchorRepositories");
  });
});
