import { describe, expect, it } from "vitest";
import {
  bareModelId,
  buildAgentLaunchArgs,
  enrichModelsWithOmpThinking,
  parseCodexConfigToml,
  parseCodexModelsCache,
  parseGrokConfigModels,
  parseGrokModelsCache,
  parseGrokModelsOutput,
  parseOmpModelsJson,
  parseOmpModelsYml,
} from "./agentLaunch.js";
describe("parseCodexConfigToml", () => {
  it("reads model and model_reasoning_effort", () => {
    const text = `
model_provider = "sudocode"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
network_access = "enabled"
`;
    expect(parseCodexConfigToml(text)).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
  });
});

describe("parseCodexModelsCache", () => {
  it("extracts slug efforts from cache without hardcoding list", () => {
    const cache = {
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          default_reasoning_level: "medium",
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "codex-auto-review",
          display_name: "hidden",
          visibility: "hide",
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    };
    const models = parseCodexModelsCache(JSON.stringify(cache));
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe("gpt-5.5");
    expect(models[0]!.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]!.defaultEffort).toBe("medium");
    expect(models[1]!.hidden).toBe(true);
  });
});

describe("enrichModelsWithOmpThinking", () => {
  it("fills empty codex config model with omp per-model thinking", () => {
    const codex = [
      {
        id: "gpt-5.6-sol",
        label: "gpt-5.6-sol",
        efforts: [] as string[],
        defaultEffort: "high",
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        // already from models_cache — must not be overwritten
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
      },
    ];
    const omp = parseOmpModelsJson(
      JSON.stringify({
        models: [
          {
            provider: "sudocode",
            id: "gpt-5.6-sol",
            selector: "sudocode/gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            thinking: ["low", "medium", "high", "xhigh", "max"],
          },
          {
            provider: "sudocode",
            id: "gpt-5.5",
            selector: "sudocode/gpt-5.5",
            name: "GPT-5.5",
            thinking: ["low", "medium", "high", "xhigh"],
          },
        ],
      }),
    );
    const out = enrichModelsWithOmpThinking(codex, omp);
    expect(bareModelId("sudocode/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(out.find((m) => m.id === "gpt-5.6-sol")!.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(out.find((m) => m.id === "gpt-5.6-sol")!.defaultEffort).toBe(
      "high",
    );
    // cache ladder preserved
    expect(out.find((m) => m.id === "gpt-5.5")!.efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("does not invent efforts when omp has none", () => {
    const out = enrichModelsWithOmpThinking(
      [{ id: "custom-model", label: "custom-model", efforts: [] }],
      [{ id: "other", label: "other", efforts: ["low", "high"] }],
    );
    expect(out[0]!.efforts).toEqual([]);
  });
});

describe("parseGrokModelsCache", () => {
  it("reads per-model reasoning_efforts from cache", () => {
    const cache = {
      models: {
        "grok-4.5": {
          info: {
            id: "grok-4.5",
            name: "Grok 4.5",
            supports_reasoning_effort: true,
            reasoning_effort: "high",
            reasoning_efforts: [
              { id: "high", value: "high", default: true },
              { id: "medium", value: "medium", default: false },
              { id: "low", value: "low", default: false },
            ],
          },
        },
      },
    };
    const models = parseGrokModelsCache(JSON.stringify(cache));
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("grok-4.5");
    expect(models[0]!.efforts).toEqual(["high", "medium", "low"]);
    expect(models[0]!.defaultEffort).toBe("high");
  });

  it("leaves empty efforts when supports_reasoning_effort is false", () => {
    const cache = {
      models: {
        "grok-fast": {
          info: {
            id: "grok-fast",
            supports_reasoning_effort: false,
            reasoning_effort: "high",
          },
        },
      },
    };
    const models = parseGrokModelsCache(JSON.stringify(cache));
    expect(models[0]!.efforts).toEqual([]);
  });
});

describe("parseGrokConfigModels", () => {
  it("reads custom model alias and base model", () => {
    const text = `
[model."sudocode-grok-4.5"]
model = "grok-4.5"
name = "Sudocode Grok 4.5"
`;
    const models = parseGrokConfigModels(text);
    expect(models[0]!.id).toBe("sudocode-grok-4.5");
    expect(models[0]!.baseModel).toBe("grok-4.5");
    expect(models[0]!.label).toBe("Sudocode Grok 4.5");
  });
});


describe("buildAgentLaunchArgs", () => {
  it("builds codex -m and -c effort from discovered choices", () => {
    expect(
      buildAgentLaunchArgs("codex", {
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ).toEqual([
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("builds claude --model and --effort", () => {
    expect(
      buildAgentLaunchArgs("claude", {
        model: "sonnet",
        effort: "high",
      }),
    ).toEqual(["--model", "sonnet", "--effort", "high"]);
  });

  it("builds grok -m and --reasoning-effort", () => {
    expect(
      buildAgentLaunchArgs("grok", {
        model: "grok-4.5",
        effort: "high",
      }),
    ).toEqual(["-m", "grok-4.5", "--reasoning-effort", "high"]);
  });

  it("builds omp --model with optional :effort", () => {
    expect(
      buildAgentLaunchArgs("omp", {
        model: "sudocode/gpt-5.5",
        effort: "high",
      }),
    ).toEqual(["--model=sudocode/gpt-5.5:high"]);
  });

  it("appends task prompt as first user message for codex/claude/grok/omp", () => {
    expect(
      buildAgentLaunchArgs("codex", {
        model: "gpt-5.6-sol",
        effort: "high",
        prompt: "修复登录 bug",
      }),
    ).toEqual([
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "修复登录 bug",
    ]);
    expect(
      buildAgentLaunchArgs("claude", {
        model: "sonnet",
        effort: "high",
        prompt: "hello",
      }),
    ).toEqual(["--model", "sonnet", "--effort", "high", "hello"]);
    expect(
      buildAgentLaunchArgs("grok", {
        model: "grok-4.5",
        prompt: "ship it",
      }),
    ).toEqual(["-m", "grok-4.5", "ship it"]);
    expect(
      buildAgentLaunchArgs("omp", {
        model: "sudocode/gpt-5.5",
        effort: "high",
        prompt: "refactor auth",
      }),
    ).toEqual(["--model=sudocode/gpt-5.5:high", "refactor auth"]);
  });
});

describe("parseGrokModelsOutput", () => {
  it("parses default and list", () => {
    const text = `
You are logged in with grok.com.
Default model: grok-4.5
Available models:
  * grok-4.5 (default)
  - sudocode-grok-4.5
`;
    expect(parseGrokModelsOutput(text)).toEqual({
      defaultModel: "grok-4.5",
      models: ["grok-4.5", "sudocode-grok-4.5"],
    });
  });
});

describe("parseOmpModelsJson", () => {
  it("parses selector and thinking levels", () => {
    const json = {
      models: [
        {
          provider: "sudocode",
          id: "gpt-5.5",
          selector: "sudocode/gpt-5.5",
          name: "GPT 5.5",
          thinking: ["low", "medium", "high"],
        },
      ],
    };
    const models = parseOmpModelsJson(JSON.stringify(json));
    expect(models.some((m) => m.id === "sudocode/gpt-5.5")).toBe(true);
    const m = models.find((x) => x.id === "sudocode/gpt-5.5")!;
    expect(m.efforts).toEqual(["low", "medium", "high"]);
  });
});

describe("parseOmpModelsYml", () => {
  it("lists model ids without inventing effort ladders", () => {
    const yml = `
providers:
  sudocode:
    models:
      - id: gpt-5.5
        name: GPT 5.5
      - id: grok-4.5
        name: Grok 4.5
`;
    const models = parseOmpModelsYml(yml);
    expect(models.some((m) => m.id === "sudocode/gpt-5.5")).toBe(true);
    expect(models.find((m) => m.id === "sudocode/gpt-5.5")!.efforts).toEqual(
      [],
    );
    expect(models.find((m) => m.id === "gpt-5.5")!.efforts).toEqual([]);
  });
});
