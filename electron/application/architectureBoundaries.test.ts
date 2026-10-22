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

  it("never starts the Anchor Relay at launch (experimental, explicit enable only)", () => {
    const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
    const main = read("electron/main.ts");
    const ipc = read("electron/ipc/register.ts");
    // Main builds the relay only lazily inside the controller's factory and
    // never reads the stored remote-access config or calls start itself.
    expect(main).not.toMatch(/\brelay\.start\(/);
    expect(main).not.toMatch(/remoteAccess\.setEnabled\(/);
    expect(main).not.toContain("getRemoteAccessConfig");
    expect(main).toContain("new RemoteAccessController(");
    expect(main).not.toMatch(/^const \w+ = new RelayConnector\(/m);
    // The only path that turns the relay on is the explicit remote:update IPC.
    expect(ipc).not.toMatch(/\brelay\.start\(/);
    expect(ipc.match(/remoteAccess\.setEnabled\(/g)?.length).toBe(1);
    expect(ipc).toMatch(/"remote:update"[\s\S]*remoteAccess\.setEnabled\(/);
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
