import type { HostSession } from "../host/types.js";
import { loadSettings, saveSettings } from "../settings.js";

/** Bump to invalidate settings.json agentLaunchCache after discovery semantics change. */
export const AGENT_LAUNCH_DISCOVERY_VERSION = 3;

export interface AgentModelOption {
  id: string;
  label: string;
  /** Only levels reported by the agent install — never invented. */
  efforts: string[];
  defaultEffort?: string;
  hidden?: boolean;
}

export interface AgentLaunchDiscovery {
  profileId: string;
  supportsModel: boolean;
  supportsEffort: boolean;
  models: AgentModelOption[];
  defaultModel?: string;
  defaultEffort?: string;
  configHome?: string;
  source?: string;
  error?: string;
  fetchedAt?: string;
  /** Served from memory or settings.json disk cache. */
  cached?: boolean;
  /** Cache schema version — must match AGENT_LAUNCH_DISCOVERY_VERSION. */
  discoveryVersion?: number;
}

export interface DiscoverLaunchOptions {
  /** Bypass memory + disk cache and re-read host config / CLI lists. */
  force?: boolean;
}

const memoryCache = new Map<string, AgentLaunchDiscovery>();

function cacheKey(host: HostSession, profileId: string): string {
  return `${host.kind}:${host.profileId}:${profileId.trim().toLowerCase()}`;
}

export function clearAgentLaunchDiscoveryCache(profileId?: string): void {
  if (!profileId) {
    memoryCache.clear();
    void loadSettings()
      .then((s) => {
        s.agentLaunchCache = {};
        return saveSettings(s);
      })
      .catch(() => undefined);
    return;
  }
  const id = profileId.trim().toLowerCase();
  for (const k of [...memoryCache.keys()]) {
    if (k.endsWith(`:${id}`)) memoryCache.delete(k);
  }
  void loadSettings()
    .then((s) => {
      const next = { ...(s.agentLaunchCache ?? {}) };
      for (const k of Object.keys(next)) {
        if (k.endsWith(`:${id}`)) delete next[k];
      }
      s.agentLaunchCache = next;
      return saveSettings(s);
    })
    .catch(() => undefined);
}

function isDiscoveryShape(v: unknown): v is AgentLaunchDiscovery {
  if (!v || typeof v !== "object") return false;
  const o = v as AgentLaunchDiscovery;
  // Accept any prior discoveryVersion: only shape matters. Bumping
  // AGENT_LAUNCH_DISCOVERY_VERSION must not force a re-probe every launch;
  // use clearAgentLaunchDiscoveryCache() when a breaking change needs wipe.
  return (
    typeof o.profileId === "string" &&
    typeof o.supportsModel === "boolean" &&
    Array.isArray(o.models)
  );
}

/**
 * Discover model / effort from the agent install on the active host.
 * Order: memory → settings.json disk → live host probe.
 * Refresh (force) always re-probes and rewrites disk.
 */
export async function discoverAgentLaunchOptions(
  host: HostSession,
  profileId: string,
  opts: DiscoverLaunchOptions = {},
): Promise<AgentLaunchDiscovery> {
  const id = profileId.trim().toLowerCase();
  const key = cacheKey(host, id);

  if (!opts.force) {
    const mem = memoryCache.get(key);
    if (mem) return { ...mem, cached: true };

    try {
      const settings = await loadSettings();
      const disk = settings.agentLaunchCache?.[key];
      if (isDiscoveryShape(disk)) {
        const restored: AgentLaunchDiscovery = { ...disk, cached: true };
        memoryCache.set(key, restored);
        return restored;
      }
    } catch {
      // ignore
    }
  } else {
    memoryCache.delete(key);
  }

  let result: AgentLaunchDiscovery;
  if (id === "codex") result = await discoverCodex(host);
  else if (id === "claude") result = await discoverClaude(host);
  else if (id === "grok") result = await discoverGrok(host);
  else if (id === "omp") result = await discoverOmp(host);
  else {
    result = {
      profileId: id,
      supportsModel: false,
      supportsEffort: false,
      models: [],
      source: "none",
    };
  }

  result = {
    ...result,
    supportsEffort:
      !!result.defaultEffort ||
      result.models.some((m) => m.efforts.length > 0),
    fetchedAt: new Date().toISOString(),
    discoveryVersion: AGENT_LAUNCH_DISCOVERY_VERSION,
    cached: false,
  };
  memoryCache.set(key, result);

  try {
    const settings = await loadSettings();
    const { cached: _c, ...toStore } = result;
    settings.agentLaunchCache = {
      ...(settings.agentLaunchCache ?? {}),
      [key]: toStore,
    };
    await saveSettings(settings);
  } catch {
    // ignore
  }

  return result;
}

export function buildAgentLaunchArgs(
  profileId: string,
  opts: { model?: string; effort?: string; prompt?: string },
): string[] {
  const id = profileId.trim().toLowerCase();
  const args: string[] = [];
  const prompt = opts.prompt?.trim();

  if (id === "codex") {
    if (opts.model?.trim()) args.push("-m", opts.model.trim());
    if (opts.effort?.trim()) {
      args.push("-c", `model_reasoning_effort="${opts.effort.trim()}"`);
    }
    if (prompt) args.push(prompt);
    return args;
  }
  if (id === "claude") {
    if (opts.model?.trim()) args.push("--model", opts.model.trim());
    if (opts.effort?.trim()) args.push("--effort", opts.effort.trim());
    if (prompt) args.push(prompt);
    return args;
  }
  if (id === "grok") {
    if (opts.model?.trim()) args.push("-m", opts.model.trim());
    if (opts.effort?.trim()) {
      args.push("--reasoning-effort", opts.effort.trim());
    }
    if (prompt) args.push(prompt);
    return args;
  }
  if (id === "omp") {
    if (opts.model?.trim()) {
      const m = opts.model.trim();
      const withEffort =
        opts.effort?.trim() && !m.includes(":")
          ? `${m}:${opts.effort.trim()}`
          : m;
      args.push(`--model=${withEffort}`);
    } else if (opts.effort?.trim()) {
      args.push(`--thinking=${opts.effort.trim()}`);
    }
    if (prompt) args.push(prompt);
    return args;
  }
  if (prompt) args.push(prompt);
  return args;
}


// ── host helpers ─────────────────────────────────────────────

async function hostHome(host: HostSession): Promise<string> {
  const cwd =
    host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  try {
    if (host.kind === "local" && process.platform === "win32") {
      const r = await host.run(cwd, "cmd.exe", [
        "/d",
        "/s",
        "/c",
        "echo %USERPROFILE%",
      ]);
      const line = r.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
      if (line) return line.trim();
    }
    const r = await host.run(cwd, "sh", ["-lc", 'printf %s "$HOME"']);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {
    // fall through
  }
  if (host.kind === "local") {
    return process.env.HOME || process.env.USERPROFILE || "";
  }
  return "/root";
}

async function readHostText(
  host: HostSession,
  filePath: string,
): Promise<string | null> {
  try {
    if (await host.exists(filePath)) {
      return await host.readFile(filePath);
    }
  } catch {
    // fall through to cat
  }
  try {
    const cwd = host.workspaceRoot || "/";
    const r = await host.run(cwd, "sh", [
      "-lc",
      `if [ -f ${shellSingleQuote(filePath)} ]; then cat ${shellSingleQuote(filePath)}; else exit 44; fi`,
    ]);
    if (r.code === 0) return r.stdout;
  } catch {
    // ignore
  }
  return null;
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinPosix(a: string, b: string): string {
  if (a.includes("\\") && !a.startsWith("/")) {
    return `${a.replace(/[\\/]+$/, "")}\\${b}`;
  }
  return `${a.replace(/\/+$/, "")}/${b}`;
}

async function runHostCommand(
  host: HostSession,
  command: string,
  args: string[],
): Promise<string | null> {
  const cwd =
    host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  try {
    const r = await host.run(cwd, command, args);
    if (r.code === 0 && r.stdout.trim()) return r.stdout;
    if (r.code === 0 && r.stderr.trim()) return r.stderr;
    if (r.stdout.trim()) return r.stdout;
  } catch {
    // ignore
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function uniqueEfforts(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list) {
    const t = e.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function pushModel(
  models: AgentModelOption[],
  id: string,
  label: string,
  efforts: string[],
): void {
  if (!id) return;
  const existing = models.find((m) => m.id === id);
  if (existing) {
    if (label && existing.label === existing.id) existing.label = label;
    existing.efforts = uniqueEfforts([...existing.efforts, ...efforts]);
    return;
  }
  models.push({ id, label: label || id, efforts: uniqueEfforts(efforts) });
}

async function envOnHost(
  host: HostSession,
  name: string,
): Promise<string | undefined> {
  const cwd =
    host.workspaceRoot || (host.kind === "local" ? process.cwd() : "/");
  try {
    if (host.kind === "local" && process.platform === "win32") {
      const r = await host.run(cwd, "cmd.exe", [
        "/d",
        "/s",
        "/c",
        `echo %${name}%`,
      ]);
      const v = r.stdout.trim().split(/\r?\n/)[0]?.trim();
      if (v && !v.includes(`%${name}%`)) return v;
      return undefined;
    }
    const r = await host.run(cwd, "sh", ["-lc", `printf %s "\${${name}-}"`]);
    const v = r.stdout.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

// ── Codex ────────────────────────────────────────────────────

async function discoverCodex(host: HostSession): Promise<AgentLaunchDiscovery> {
  const home = await hostHome(host);
  const codexHome =
    (await envOnHost(host, "CODEX_HOME")) ||
    (home ? `${home.replace(/\/$/, "")}/.codex` : "");
  if (!codexHome) {
    return {
      profileId: "codex",
      supportsModel: true,
      supportsEffort: true,
      models: [],
      error: "Cannot resolve CODEX_HOME / $HOME",
      source: "codex-home-missing",
    };
  }

  const configText = await readHostText(
    host,
    joinPosix(codexHome, "config.toml"),
  );
  const cacheText = await readHostText(
    host,
    joinPosix(codexHome, "models_cache.json"),
  );
  const cfg = parseCodexConfigToml(configText ?? "");
  const fromCache = parseCodexModelsCache(cacheText ?? "");

  const byId = new Map<string, AgentModelOption>();
  for (const m of fromCache) byId.set(m.id, m);

  // Config default model may be a custom/provider slug absent from OpenAI's
  // models_cache.json (e.g. gpt-5.6-sol). Keep it, but do NOT collapse efforts
  // to the single config value — that is only the default, not the ladder.
  if (cfg.model && !byId.has(cfg.model)) {
    byId.set(cfg.model, {
      id: cfg.model,
      label: cfg.model,
      efforts: [],
      defaultEffort: cfg.effort,
    });
  }

  let models = [...byId.values()].filter(
    (m) => !m.hidden || m.id === cfg.model,
  );
  if (models.length === 0 && cfg.model) {
    models = [
      {
        id: cfg.model,
        label: cfg.model,
        efforts: [],
        defaultEffort: cfg.effort,
      },
    ];
  }

  // OMP catalogs per-model thinking for provider models (same bare ids).
  // Use it the way OMP does: real thinking arrays, never invent ladders.
  let sourceParts: string[] = [];
  if (cacheText) sourceParts.push("models_cache.json");
  if (configText) sourceParts.push("config.toml");

  const ompJson = await runHostCommand(host, "omp", ["models", "--json"]);
  if (ompJson) {
    const ompModels = parseOmpModelsJson(ompJson);
    if (ompModels.length) {
      models = enrichModelsWithOmpThinking(models, ompModels);
      sourceParts.push("omp models --json");
    }
  }

  // Config effort is the preferred default for the configured model only.
  if (cfg.effort) {
    models = models.map((m) => {
      if (m.id !== cfg.model && bareModelId(m.id) !== bareModelId(cfg.model ?? "")) {
        return m;
      }
      const defaultEffort = m.efforts.includes(cfg.effort!)
        ? cfg.effort
        : (m.defaultEffort ?? m.efforts[0] ?? cfg.effort);
      return { ...m, defaultEffort };
    });
  }

  models.sort((a, b) => {
    if (a.id === cfg.model) return -1;
    if (b.id === cfg.model) return 1;
    return a.label.localeCompare(b.label);
  });

  return {
    profileId: "codex",
    supportsModel: true,
    supportsEffort:
      !!cfg.effort || models.some((m) => m.efforts.length > 0),
    models,
    defaultModel: cfg.model,
    defaultEffort: cfg.effort,
    configHome: codexHome,
    source: sourceParts.length ? sourceParts.join("+") : "empty",
  };
}

/** Leaf model id: `sudocode/gpt-5.6-sol` → `gpt-5.6-sol`, strip `:effort`. */
export function bareModelId(id: string): string {
  const noEffort = id.split(":")[0] ?? id;
  const parts = noEffort.split("/");
  return (parts[parts.length - 1] || noEffort).trim();
}

/**
 * Fill empty effort ladders from OMP's per-model `thinking` arrays (by bare id).
 * Does not invent levels; does not overwrite non-empty models_cache ladders.
 */
export function enrichModelsWithOmpThinking(
  models: AgentModelOption[],
  ompModels: AgentModelOption[],
): AgentModelOption[] {
  const effortsByBare = new Map<string, string[]>();
  const labelByBare = new Map<string, string>();
  for (const m of ompModels) {
    if (!m.efforts.length) continue;
    const bare = bareModelId(m.id);
    if (!bare) continue;
    effortsByBare.set(
      bare,
      uniqueEfforts([...(effortsByBare.get(bare) ?? []), ...m.efforts]),
    );
    if (m.label && m.label !== m.id) labelByBare.set(bare, m.label);
  }

  return models.map((m) => {
    if (m.efforts.length > 0) return m;
    const bare = bareModelId(m.id);
    const efforts = effortsByBare.get(bare);
    if (!efforts?.length) return m;
    const defaultEffort =
      (m.defaultEffort && efforts.includes(m.defaultEffort) && m.defaultEffort) ||
      (efforts.includes("medium") ? "medium" : efforts[0]);
    return {
      ...m,
      label:
        m.label === m.id && labelByBare.has(bare)
          ? labelByBare.get(bare)!
          : m.label,
      efforts,
      defaultEffort,
    };
  });
}

export function parseCodexConfigToml(text: string): {
  model?: string;
  effort?: string;
} {
  let model: string | undefined;
  let effort: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("[")) continue;
    const m = t.match(/^model\s*=\s*"([^"]+)"/);
    if (m) model = m[1];
    const e = t.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/);
    if (e) effort = e[1];
  }
  return { model, effort };
}

export function parseCodexModelsCache(text: string): AgentModelOption[] {
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text) as {
      models?: Array<Record<string, unknown>>;
    };
    const list = Array.isArray(data.models) ? data.models : [];
    const out: AgentModelOption[] = [];
    for (const m of list) {
      const id = String(m.slug || m.id || m.model || "").trim();
      if (!id) continue;
      const efforts: string[] = [];
      const levels = m.supported_reasoning_levels;
      if (Array.isArray(levels)) {
        for (const lv of levels) {
          if (lv && typeof lv === "object" && "effort" in lv) {
            const e = String((lv as { effort: unknown }).effort || "").trim();
            if (e) efforts.push(e);
          }
        }
      }
      out.push({
        id,
        label: String(m.display_name || m.name || id),
        efforts: uniqueEfforts(efforts),
        defaultEffort:
          typeof m.default_reasoning_level === "string"
            ? m.default_reasoning_level
            : undefined,
        hidden: String(m.visibility || "list") === "hide",
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── Claude ───────────────────────────────────────────────────

async function discoverClaude(
  host: HostSession,
): Promise<AgentLaunchDiscovery> {
  const home = await hostHome(host);
  const claudeHome = home ? joinPosix(home.replace(/\/$/, ""), ".claude") : "";
  const settingsPath = claudeHome
    ? joinPosix(claudeHome, "settings.json")
    : "";
  const localPath = claudeHome
    ? joinPosix(claudeHome, "settings.local.json")
    : "";
  const text =
    (settingsPath ? await readHostText(host, settingsPath) : null) ??
    (localPath ? await readHostText(host, localPath) : null);

  let defaultModel: string | undefined;
  let defaultEffort: string | undefined;
  const models: AgentModelOption[] = [];
  const effortSet = new Set<string>();

  if (text) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const env =
        j.env && typeof j.env === "object"
          ? (j.env as Record<string, unknown>)
          : {};
      const aliasMap: Record<string, string> = {};
      const sonnet = str(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
      const opus = str(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
      const haiku = str(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
      if (sonnet) aliasMap.sonnet = sonnet;
      if (opus) aliasMap.opus = opus;
      if (haiku) aliasMap.haiku = haiku;

      const rawModel = str(j.model) || str(j.defaultModel);
      const envModel = str(env.ANTHROPIC_MODEL);
      defaultModel = rawModel || envModel || undefined;

      const rawEffort =
        str(j.effortLevel) ||
        str(j.effort) ||
        str(env.CLAUDE_CODE_EFFORT_LEVEL);
      if (rawEffort) {
        defaultEffort = rawEffort;
        effortSet.add(rawEffort);
      }

      for (const [alias, resolved] of Object.entries(aliasMap)) {
        pushModel(models, alias, `${alias} → ${resolved}`, []);
        pushModel(models, resolved, resolved, []);
      }
      if (envModel) pushModel(models, envModel, envModel, []);
      if (rawModel) {
        const label =
          aliasMap[rawModel] && aliasMap[rawModel] !== rawModel
            ? `${rawModel} → ${aliasMap[rawModel]}`
            : rawModel;
        pushModel(models, rawModel, label, []);
      }

      if (effortSet.size > 0) {
        const efforts = [...effortSet];
        for (const m of models) {
          m.efforts = uniqueEfforts([...m.efforts, ...efforts]);
          m.defaultEffort = m.defaultEffort ?? defaultEffort;
        }
      }
    } catch (err) {
      return {
        profileId: "claude",
        supportsModel: true,
        supportsEffort: true,
        models: [],
        configHome: claudeHome || undefined,
        source: "settings-parse-error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    profileId: "claude",
    supportsModel: true,
    supportsEffort:
      effortSet.size > 0 || models.some((m) => m.efforts.length > 0),
    models,
    defaultModel,
    defaultEffort,
    configHome: claudeHome || undefined,
    source: text ? "settings.json" : claudeHome ? "settings-missing" : "none",
    error:
      !text && claudeHome
        ? `Could not read ${settingsPath || "~/.claude/settings.json"}`
        : undefined,
  };
}

// ── Grok ─────────────────────────────────────────────────────

async function discoverGrok(host: HostSession): Promise<AgentLaunchDiscovery> {
  const home = await hostHome(host);
  const grokHome = home ? joinPosix(home.replace(/\/$/, ""), ".grok") : "";
  const configText = grokHome
    ? await readHostText(host, joinPosix(grokHome, "config.toml"))
    : null;
  const cacheText = grokHome
    ? await readHostText(host, joinPosix(grokHome, "models_cache.json"))
    : null;

  const models: AgentModelOption[] = [];
  const fromCache = parseGrokModelsCache(cacheText ?? "");
  for (const m of fromCache) {
    pushModel(models, m.id, m.label, m.efforts);
    const hit = models.find((x) => x.id === m.id);
    if (hit) {
      if (m.defaultEffort) hit.defaultEffort = m.defaultEffort;
      if (m.hidden) hit.hidden = m.hidden;
    }
  }

  // Custom config models (e.g. sudocode-grok-4.5): list them, but do NOT
  // inherit base-model reasoning_efforts. Custom/Sudocode backends often
  // reject --reasoning-effort even when the upstream slug is "grok-4.5".
  const configModels = parseGrokConfigModels(configText ?? "");
  for (const m of configModels) {
    if (!models.some((x) => x.id === m.id)) {
      pushModel(models, m.id, m.label, []);
    } else if (m.label) {
      const hit = models.find((x) => x.id === m.id);
      if (hit && hit.label === hit.id) hit.label = m.label;
    }
  }

  let defaultModel: string | undefined;
  const listed = await runHostCommand(host, "grok", ["models"]);
  if (listed) {
    const parsed = parseGrokModelsOutput(listed);
    defaultModel = parsed.defaultModel;
    for (const mid of parsed.models) {
      if (!models.some((x) => x.id === mid)) pushModel(models, mid, mid, []);
    }
  }

  // Prefer official cache + config + `grok models` only.
  // Do not fill efforts from OMP — that invents --reasoning-effort for
  // endpoints that reject it.
  const sourceParts: string[] = [];
  if (fromCache.length) sourceParts.push("models_cache.json");
  if (configText) sourceParts.push("config.toml");
  if (listed) sourceParts.push("grok models");

  if (defaultModel) {
    models.sort((a, b) => {
      if (a.id === defaultModel) return -1;
      if (b.id === defaultModel) return 1;
      return a.label.localeCompare(b.label);
    });
  }

  const visible = models.filter((m) => !m.hidden || m.id === defaultModel);
  // defaultEffort only if the default model itself has efforts.
  const defaultEffort = visible.find((m) => m.id === defaultModel)?.defaultEffort;

  return {
    profileId: "grok",
    supportsModel: true,
    supportsEffort: visible.some((m) => m.efforts.length > 0),
    models: visible,
    defaultModel,
    defaultEffort,
    configHome: grokHome || undefined,
    source: sourceParts.length ? sourceParts.join("+") : "empty",
    error:
      visible.length === 0
        ? "Could not list models (`grok models` / models_cache empty)"
        : undefined,
  };
}

/** Parse ~/.grok/models_cache.json — per-model reasoning_efforts (real, not invented). */
export function parseGrokModelsCache(text: string): AgentModelOption[] {
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text) as {
      models?:
        | Record<string, { info?: Record<string, unknown> } | Record<string, unknown>>
        | Array<Record<string, unknown>>;
    };
    const out: AgentModelOption[] = [];

    const ingest = (idHint: string, raw: Record<string, unknown>) => {
      const info =
        raw.info && typeof raw.info === "object"
          ? (raw.info as Record<string, unknown>)
          : raw;
      const id = str(info.id) || str(info.model) || idHint;
      if (!id) return;
      const efforts: string[] = [];
      let defaultEffort: string | undefined;

      const list = info.reasoning_efforts;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const o = item as Record<string, unknown>;
          const e = str(o.value) || str(o.id) || str(o.effort);
          if (e) efforts.push(e);
          if (o.default === true) defaultEffort = e || defaultEffort;
        }
      }
      // Single default string field when array absent.
      if (!efforts.length) {
        const single = str(info.reasoning_effort);
        if (single && info.supports_reasoning_effort !== false) {
          // Only a default is known — surface that one value, do not invent ladder.
          efforts.push(single);
          defaultEffort = single;
        }
      } else if (!defaultEffort) {
        const single = str(info.reasoning_effort);
        if (single && efforts.includes(single)) defaultEffort = single;
        else defaultEffort = efforts[0];
      }

      // If model explicitly does not support effort, leave empty.
      if (info.supports_reasoning_effort === false) {
        out.push({
          id,
          label: str(info.name) || id,
          efforts: [],
          hidden: info.hidden === true,
        });
        return;
      }

      out.push({
        id,
        label: str(info.name) || id,
        efforts: uniqueEfforts(efforts),
        defaultEffort,
        hidden: info.hidden === true,
      });
    };

    if (Array.isArray(data.models)) {
      for (const m of data.models) {
        if (m && typeof m === "object") ingest(str(m.id) || str(m.model), m);
      }
    } else if (data.models && typeof data.models === "object") {
      for (const [key, val] of Object.entries(data.models)) {
        if (val && typeof val === "object") {
          ingest(key, val as Record<string, unknown>);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function parseGrokModelsOutput(text: string): {
  defaultModel?: string;
  models: string[];
} {
  const models: string[] = [];
  let defaultModel: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const def = line.match(/Default model:\s*(\S+)/i);
    if (def) defaultModel = def[1];
    const star = line.match(/^\s*[\*\-]\s+(\S+)/);
    if (star) {
      const mid = star[1]!.replace(/\(default\)/i, "").trim();
      if (mid && !models.includes(mid)) models.push(mid);
    }
  }
  if (defaultModel && !models.includes(defaultModel)) {
    models.unshift(defaultModel);
  }
  return { defaultModel, models };
}

export function parseGrokConfigModels(text: string): Array<
  AgentModelOption & { baseModel?: string }
> {
  const out: Array<AgentModelOption & { baseModel?: string }> = [];
  let current: (AgentModelOption & { baseModel?: string }) | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const hdr = t.match(/^\[model\."([^"]+)"\]/);
    if (hdr) {
      current = { id: hdr[1]!, label: hdr[1]!, efforts: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const name = t.match(/^name\s*=\s*"([^"]+)"/);
    if (name) current.label = name[1]!;
    // Upstream model id this custom entry routes to.
    const base = t.match(/^model\s*=\s*"([^"]+)"/);
    if (base) current.baseModel = base[1]!;
  }
  return out;
}

// ── OMP ──────────────────────────────────────────────────────

async function discoverOmp(host: HostSession): Promise<AgentLaunchDiscovery> {
  const home = await hostHome(host);
  const ompHome = home ? joinPosix(home.replace(/\/$/, ""), ".omp") : "";
  const agentDir = ompHome ? joinPosix(ompHome, "agent") : "";
  const configText = agentDir
    ? await readHostText(host, joinPosix(agentDir, "config.yml"))
    : null;
  const modelsYml = agentDir
    ? await readHostText(host, joinPosix(agentDir, "models.yml"))
    : null;
  const cfg = parseOmpConfigYaml(configText ?? "");

  let models: AgentModelOption[] = [];
  let source = "empty";

  // Prefer JSON: real per-model thinking arrays.
  const jsonOut = await runHostCommand(host, "omp", ["models", "--json"]);
  if (jsonOut) {
    models = parseOmpModelsJson(jsonOut);
    if (models.length) source = "omp models --json";
  }
  if (models.length === 0 && modelsYml) {
    models = parseOmpModelsYml(modelsYml);
    if (models.length) source = "models.yml";
  }
  if (models.length === 0) {
    const textOut = await runHostCommand(host, "omp", ["models"]);
    if (textOut) {
      models = parseOmpModelsTable(textOut);
      if (models.length) source = "omp models";
    }
  }

  if (cfg.defaultModel) {
    const base = cfg.defaultModel.split(":")[0]!;
    if (
      !models.some(
        (m) =>
          m.id === cfg.defaultModel ||
          m.id === base ||
          m.id.endsWith(`/${base}`) ||
          m.id.endsWith(base),
      )
    ) {
      const efforts =
        cfg.thinking && cfg.thinking !== "auto" ? [cfg.thinking] : [];
      pushModel(models, cfg.defaultModel, cfg.defaultModel, efforts);
    }
  }

  const def = cfg.defaultModel;
  if (def) {
    models.sort((a, b) => {
      const score = (id: string) => {
        const leaf = def.split("/").pop() || def;
        return id === def ||
          id.endsWith(`/${def}`) ||
          def.endsWith(id) ||
          id.endsWith(leaf)
          ? 0
          : 1;
      };
      const d = score(a.id) - score(b.id);
      return d !== 0 ? d : a.label.localeCompare(b.label);
    });
  }

  const defaultEffort =
    cfg.thinking && cfg.thinking !== "auto" ? cfg.thinking : undefined;

  // Only seed a single known default effort — never invent a full ladder.
  if (defaultEffort) {
    for (const m of models) {
      if (m.efforts.length === 0) {
        m.efforts = [defaultEffort];
        m.defaultEffort = defaultEffort;
      } else if (!m.defaultEffort) {
        m.defaultEffort = m.efforts.includes(defaultEffort)
          ? defaultEffort
          : m.efforts[0];
      }
    }
  }

  return {
    profileId: "omp",
    supportsModel: true,
    supportsEffort:
      models.some((m) => m.efforts.length > 0) || !!defaultEffort,
    models,
    defaultModel: def,
    defaultEffort,
    configHome: ompHome || undefined,
    source,
    error:
      models.length === 0
        ? "Could not list models (models.yml / omp models empty)"
        : undefined,
  };
}

export function parseOmpConfigYaml(text: string): {
  defaultModel?: string;
  thinking?: string;
} {
  let defaultModel: string | undefined;
  let thinking: string | undefined;
  let inRoles = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "modelRoles:" || /^modelRoles:\s*$/.test(line.trim())) {
      inRoles = true;
      continue;
    }
    if (inRoles) {
      if (/^\S/.test(line) && !line.startsWith(" ") && !line.startsWith("\t")) {
        inRoles = false;
      } else {
        const m = line.match(/^\s+default:\s*(\S+)/);
        if (m) defaultModel = m[1];
      }
    }
    const th = line.match(/^defaultThinkingLevel:\s*(\S+)/);
    if (th) thinking = th[1];
  }
  return { defaultModel, thinking };
}

/** models.yml has ids only — no invented efforts. */
export function parseOmpModelsYml(text: string): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  let provider = "";
  let currentId = "";
  let currentName = "";
  let inModels = false;

  const flush = () => {
    if (!currentId || !provider) return;
    const selector = `${provider}/${currentId}`;
    pushModel(out, selector, currentName || selector, []);
    pushModel(out, currentId, currentName || currentId, []);
    currentId = "";
    currentName = "";
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    if (/^providers:\s*$/.test(line)) continue;

    const prov = line.match(/^  ([A-Za-z0-9._-]+):\s*$/);
    if (prov && raw.startsWith("  ") && !raw.startsWith("    ")) {
      flush();
      provider = prov[1]!;
      inModels = false;
      continue;
    }

    if (/^\s+models:\s*$/.test(line)) {
      inModels = true;
      continue;
    }
    if (!inModels || !provider) continue;

    if (/^  [A-Za-z]/.test(raw) && !raw.startsWith("    ")) {
      flush();
      inModels = false;
      continue;
    }

    const idLine = line.match(/^\s+- id:\s*(\S+)\s*$/);
    if (idLine) {
      flush();
      currentId = idLine[1]!;
      continue;
    }
    const nameLine = line.match(/^\s+name:\s*(.+)\s*$/);
    if (nameLine && currentId) {
      currentName = nameLine[1]!.replace(/^["']|["']$/g, "").trim();
    }
  }
  flush();
  return out;
}

export function parseOmpModelsJson(text: string): AgentModelOption[] {
  try {
    const data = JSON.parse(text) as {
      models?: Array<Record<string, unknown>>;
    };
    const list = Array.isArray(data.models) ? data.models : [];
    const out: AgentModelOption[] = [];
    for (const m of list) {
      const selector = str(m.selector);
      const id = selector || str(m.id) || str(m.model) || str(m.name);
      if (!id) continue;
      const label =
        str(m.name) ||
        (str(m.provider) && str(m.id) ? `${m.provider}/${m.id}` : id);
      const efforts: string[] = [];
      const thinking = m.thinking;
      if (Array.isArray(thinking)) {
        for (const e of thinking) {
          if (typeof e === "string" && e !== "-") efforts.push(e);
        }
      } else if (typeof thinking === "string" && thinking !== "-") {
        for (const part of thinking.split(/[,\s]+/)) {
          if (part && part !== "-") efforts.push(part);
        }
      }
      pushModel(out, id, label, efforts);
      const bare = str(m.id);
      if (bare && bare !== id) pushModel(out, bare, label, efforts);
    }
    return out;
  } catch {
    return [];
  }
}

export function parseOmpModelsTable(text: string): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  let provider = "";
  for (const line of text.split(/\r?\n/)) {
    const prov = line.match(/^(\S.+)\s+\((\d+)\)\s*$/);
    if (prov) {
      provider = prov[1]!.trim();
      continue;
    }
    if (!line.includes("│")) continue;
    const cells = line
      .split("│")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 2) continue;
    const model = cells[0]!;
    if (model === "model" || model.startsWith("─") || model.startsWith("┌")) {
      continue;
    }
    if (!/^[\w./:+-]+$/.test(model)) continue;
    const thinking = cells[3] ?? "";
    const efforts =
      thinking && thinking !== "-"
        ? thinking.split(/[,\s]+/).filter((e) => e && e !== "-")
        : [];
    const id = provider ? `${provider}/${model}` : model;
    pushModel(out, id, id, efforts);
    pushModel(out, model, model, efforts);
  }
  return out;
}
