import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalHostSession } from "../host/localHost.js";
import {
  ensureSpawnHelperExecutable,
  extractFirstAgentUserPrompt,
  formatAgentSessionTitle,
  normalizeAgentTopic,
  normalizeDynamicTitle,
  summarizeTopicLocal,
  TerminalService,
  titleFromCwd,
} from "./terminalService.js";

describe("ensureSpawnHelperExecutable", () => {
  it("makes node-pty spawn-helper executable when present", () => {
    ensureSpawnHelperExecutable();
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }
    const helper = path.join(
      process.cwd(),
      "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    );
    if (!fs.existsSync(helper)) {
      expect(true).toBe(true);
      return;
    }
    const mode = fs.statSync(helper).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("formatAgentSessionTitle", () => {
  it("joins CLI name with local HH:mm", () => {
    const at = new Date(2026, 6, 22, 18, 5, 0);
    expect(formatAgentSessionTitle("Codex", at)).toBe("Codex · 18:05");
    expect(formatAgentSessionTitle("  Claude Code  ", at)).toBe(
      "Claude Code · 18:05",
    );
  });
});

describe("titleFromCwd / normalizeDynamicTitle", () => {
  it("uses directory basename for shell titles", () => {
    expect(titleFromCwd("wsl", "/home/miles/pyoneer04")).toBe("pyoneer04");
    expect(titleFromCwd("wsl", "/home/miles/pyoneer04/")).toBe("pyoneer04");
    expect(titleFromCwd("local", "C:\\\\Users\\\\miles\\\\repo")).toBe("repo");
    expect(titleFromCwd("wsl", "/")).toBe("/");
  });

  it("normalizes OSC-style titles to basename", () => {
    expect(normalizeDynamicTitle("miles@host:~/pyoneer04", "x")).toBe(
      "pyoneer04",
    );
    expect(normalizeDynamicTitle("/home/miles/proj/src", "x")).toBe("src");
    expect(normalizeDynamicTitle("user@host: /tmp/foo", "x")).toBe("foo");
    expect(normalizeDynamicTitle("", "keep")).toBe("keep");
  });
});
describe("normalizeAgentTopic / extractFirstAgentUserPrompt", () => {
  it("turns first user prompt into topic and rejects agent brand names", () => {
    expect(
      normalizeAgentTopic("讨论时戳同步设计", { title: "Codex", agentId: "codex" }),
    ).toBe("讨论时戳同步设计");
    expect(
      normalizeAgentTopic("Codex", { title: "Codex", agentId: "codex" }),
    ).toBeNull();
    expect(
      normalizeAgentTopic("修复 cam_cli 光标删除", {
        title: "Claude Code",
        agentId: "claude",
      }),
    ).toBe("修复 cam_cli 光标删除");
  });

  it("rejects usernames paths numbers and host chrome as topics", () => {
    expect(
      normalizeAgentTopic("miles", { title: "Codex", agentId: "codex" }),
    ).toBeNull();
    expect(
      normalizeAgentTopic("1", { title: "Codex", agentId: "codex" }),
    ).toBeNull();
    expect(
      normalizeAgentTopic("4;0m>7u", { title: "Codex", agentId: "codex" }),
    ).toBeNull();
    expect(
      normalizeAgentTopic("miles@host:~/pyoneer04", {
        title: "Codex",
        agentId: "codex",
      }),
    ).toBeNull();
  });

  it("allows short real prompts like 你好 and what", () => {
    expect(
      normalizeAgentTopic("你好", { title: "Codex", agentId: "codex" }),
    ).toBe("你好");
    expect(
      normalizeAgentTopic("what", { title: "Codex", agentId: "codex" }),
    ).toBe("what");
  });

  it("scrapes Codex-style › lines and ignores path chrome", () => {
    const sample = [
      "OpenAI Codex (v0.145.0)",
      "model:    gpt-5.6",
      "directory: ~/pyoneer04",
      "Tip: New Build faster with Codex.",
      "miles@host:/home/miles/pyoneer04",
      "1",
      "› 你好",
      "• 你好。你现在想处理代码开发…",
      "› Write tests for @filename",
    ].join("\n");
    expect(extractFirstAgentUserPrompt(sample)).toBe("你好");
  });

  it("ignores ANSI debris and finds later › what", () => {
    // Simulates incomplete CSI + prompt fragments seen in real TUI streams
    const sample =
      "\u001b[4;0m\u001b[?7u\n4;0m>7u\n› what\n◦ Working (3s • esc to interrupt)\n";
    expect(extractFirstAgentUserPrompt(sample)).toBe("what");
  });

  it("prefers 你好 over earlier junk lines in mixed output", () => {
    const sample =
      "directory: ~/pyoneer04\n› 1\n• spinner\n› 你好\n• 你好！很高兴见到你。";
    expect(extractFirstAgentUserPrompt(sample)).toBe("你好");
  });
});

describe("summarizeTopicLocal", () => {
  it("keeps short prompts near-verbatim", () => {
    expect(summarizeTopicLocal("你好")).toBe("你好");
    expect(summarizeTopicLocal("修复 cam_cli 光标删除")).toBe(
      "修复 cam_cli 光标删除",
    );
  });

  it("strips polite fillers and takes first clause", () => {
    expect(
      summarizeTopicLocal("请帮我讨论一下时戳同步设计，并给出方案和风险。"),
    ).toBe("讨论一下时戳同步设计");
    expect(
      summarizeTopicLocal(
        "Please help me write tests for the login flow and edge cases.",
      ),
    ).toMatch(/^write tests for the login flow/i);
  });

  it("compresses @paths and long blobs", () => {
    const t = summarizeTopicLocal(
      "请帮我根据 @/home/miles/pyoneer06/operator/service.ts 修复删除光标的问题，并补充单测和回归用例，注意边界条件。",
    );
    expect(t).toBeTruthy();
    expect(t!.length).toBeLessThanOrEqual(24);
    expect(t).toContain("@service.ts");
  });
});

describe("TerminalService.create (integration)", () => {
  const host = new LocalHostSession("term-test");
  const service = new TerminalService(() => null, () => host);
  const tabs: string[] = [];

  afterEach(() => {
    for (const id of tabs) service.kill(id);
    tabs.length = 0;
    service.disposeAll();
  });

  it(
    "spawns a local shell without posix_spawnp error",
    async () => {
      const cwd = os.tmpdir();
      const tab = await service.create({ cwd, cols: 80, rows: 24 });
      tabs.push(tab.id);
      expect(tab.status).toBe("running");
      expect(tab.cwd).toBeTruthy();
      expect(tab.id).toBeTruthy();
      expect(tab.kind).toBe("shell");
      expect(tab.title).toBe(titleFromCwd("local", cwd));
      expect(() => service.write(tab.id, "echo anchor-pty-ok\r")).not.toThrow();
      expect(() => service.resize(tab.id, 100, 30)).not.toThrow();
      const updated = service.applyDynamicTitle(tab.id, "user@host:~/other-dir");
      expect(updated?.title).toBe("other-dir");
    },
    15_000,
  );
});
