/**
 * Operator config (local mode).
 *
 * Settings the bot must not be able to change: models, the Ollama endpoint,
 * identity, genesis prompt, pinned state paths and the placeholder balance.
 * The file is bind-mounted read-only into the bot container at
 * /etc/automaton/operator.json (see scripts/bots/bot.sh); it never lives on
 * the bot's writable volume.
 *
 * Local mode is on when AUTOMATON_MODE=local or the operator file exists.
 * If local mode is requested and the file is missing or invalid we throw,
 * rather than silently falling back to Conway/paid behaviour.
 */

import fs from "fs";

export const DEFAULT_OPERATOR_CONFIG_PATH = "/etc/automaton/operator.json";

/** State paths pinned in local mode; automaton.json cannot repoint them. */
export const PINNED_PATHS = {
  dbPath: "~/.automaton/state.db",
  heartbeatConfigPath: "~/.automaton/heartbeat.yml",
  skillsDir: "~/.automaton/skills",
} as const;

/** Any accidental Conway call in local mode goes nowhere. */
export const DISABLED_CONWAY_URL = "https://conway.disabled.invalid";

export interface OperatorOllamaConfig {
  /** Gateway URL, scheme://host:port only. */
  baseUrl: string;
  /** Main model (high/normal tiers). */
  model: string;
  /** Small model (low_compute/critical tiers). */
  lowComputeModel: string;
  /** Context window sent as num_ctx on every request. */
  numCtx: number;
  /** Max output tokens per turn (num_predict). */
  maxTokensPerTurn: number;
  /** Let thinking models (qwen3) reason before answering. */
  think: boolean;
}

export interface OperatorConfig {
  botId: string;
  /** Identity address. No private key exists for it in local mode. */
  identityAddress: string;
  creatorAddress: string;
  genesisPrompt: string;
  ollama: OperatorOllamaConfig;
  /** Placeholder balance until the bank's SimLedger exists (step 4). */
  simBalanceCents: number;
  /** Optional: exit cleanly after this many turns in this process (test runs). */
  maxTurns?: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BOT_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MODEL = /^[A-Za-z0-9._:\/-]{1,100}$/;

function fail(path: string, msg: string): never {
  throw new Error(`Invalid operator config ${path}: ${msg}`);
}

export function parseOperatorConfig(raw: unknown, path = "operator.json"): OperatorConfig {
  if (!raw || typeof raw !== "object") fail(path, "not an object");
  const r = raw as Record<string, any>;
  const o = r.ollama as Record<string, any> | undefined;
  if (!o || typeof o !== "object") fail(path, "missing ollama section");

  if (typeof r.botId !== "string" || !BOT_ID.test(r.botId)) fail(path, "botId");
  if (typeof r.identityAddress !== "string" || !ADDRESS.test(r.identityAddress)) fail(path, "identityAddress");
  if (typeof r.creatorAddress !== "string" || !ADDRESS.test(r.creatorAddress)) fail(path, "creatorAddress");
  if (typeof r.genesisPrompt !== "string" || r.genesisPrompt.trim() === "") fail(path, "genesisPrompt");
  if (!Number.isInteger(r.simBalanceCents) || r.simBalanceCents < 0) fail(path, "simBalanceCents");
  if (r.maxTurns !== undefined && (!Number.isInteger(r.maxTurns) || r.maxTurns < 1 || r.maxTurns > 10_000)) {
    fail(path, "maxTurns");
  }

  let url: URL;
  try {
    url = new URL(o.baseUrl);
  } catch {
    fail(path, "ollama.baseUrl is not a URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) fail(path, "ollama.baseUrl must be http(s)");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    fail(path, "ollama.baseUrl must be scheme://host:port only");
  }
  for (const key of ["model", "lowComputeModel"]) {
    if (typeof o[key] !== "string" || !MODEL.test(o[key])) fail(path, `ollama.${key}`);
  }
  if (!Number.isInteger(o.numCtx) || o.numCtx < 2048 || o.numCtx > 131072) fail(path, "ollama.numCtx");
  if (!Number.isInteger(o.maxTokensPerTurn) || o.maxTokensPerTurn < 64 || o.maxTokensPerTurn > o.numCtx) {
    fail(path, "ollama.maxTokensPerTurn");
  }
  if (typeof o.think !== "boolean") fail(path, "ollama.think");

  return Object.freeze({
    botId: r.botId,
    identityAddress: r.identityAddress,
    creatorAddress: r.creatorAddress,
    genesisPrompt: r.genesisPrompt,
    simBalanceCents: r.simBalanceCents,
    ...(r.maxTurns !== undefined ? { maxTurns: r.maxTurns } : {}),
    ollama: Object.freeze({
      baseUrl: url.origin,
      model: o.model,
      lowComputeModel: o.lowComputeModel,
      numCtx: o.numCtx,
      maxTokensPerTurn: o.maxTokensPerTurn,
      think: o.think,
    }),
  });
}

function operatorConfigPath(): string {
  return process.env.AUTOMATON_OPERATOR_CONFIG || DEFAULT_OPERATOR_CONFIG_PATH;
}

let cached: { path: string; config: OperatorConfig | null } | undefined;

/**
 * The operator config, or null when not in local mode.
 * Throws if local mode is requested but the file is missing or invalid.
 */
export function getOperatorConfig(): OperatorConfig | null {
  const path = operatorConfigPath();
  if (cached && cached.path === path) return cached.config;

  const requested = process.env.AUTOMATON_MODE === "local";
  let config: OperatorConfig | null = null;
  if (fs.existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    } catch (err: any) {
      fail(path, `unreadable (${err.message})`);
    }
    config = parseOperatorConfig(raw, path);
  } else if (requested) {
    throw new Error(`AUTOMATON_MODE=local but operator config ${path} does not exist`);
  }

  cached = { path, config };
  return config;
}

export function isLocalMode(): boolean {
  return getOperatorConfig() !== null;
}

/** For tests. */
export function resetOperatorConfigCache(): void {
  cached = undefined;
}

/** The operator's models as model-registry entries (local mode). */
export function localModelEntries(config: {
  inferenceModel: string;
  maxTokensPerTurn: number;
  ollamaNumCtx?: number;
  modelStrategy?: { lowComputeModel: string };
}): { modelId: string; maxTokens: number; contextWindow: number }[] {
  const contextWindow = config.ollamaNumCtx ?? 16384;
  const ids = new Set([config.inferenceModel, config.modelStrategy?.lowComputeModel].filter(Boolean) as string[]);
  return [...ids].map((modelId) => ({ modelId, maxTokens: config.maxTokensPerTurn, contextWindow }));
}
