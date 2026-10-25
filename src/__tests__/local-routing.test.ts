/**
 * Local mode routing: only the operator's Ollama models, at every tier,
 * for both the agent-turn router and the orchestration provider registry.
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MIGRATION_V6 } from "../state/schema.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { localModelEntries } from "../operator/config.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG, type SurvivalTier } from "../types.js";

const STRATEGY = {
  ...DEFAULT_MODEL_STRATEGY_CONFIG,
  inferenceModel: "qwen3:8b",
  lowComputeModel: "qwen3:4b",
  criticalModel: "qwen3:4b",
  maxTokensPerTurn: 2048,
  enableModelFallback: false,
};
const ENTRIES = localModelEntries({
  inferenceModel: "qwen3:8b",
  maxTokensPerTurn: 2048,
  ollamaNumCtx: 16384,
  modelStrategy: STRATEGY,
});

let db: BetterSqlite3.Database;
let registry: ModelRegistry;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(MIGRATION_V6);
  registry = new ModelRegistry(db);
  // Simulate a volume that previously ran in Conway mode: paid baseline enabled.
  registry.initialize();
  registry.initializeLocal(ENTRIES);
});

afterEach(() => db.close());

function router(local = true) {
  return new InferenceRouter(db, registry, new InferenceBudgetTracker(db, STRATEGY), { localMode: local });
}

describe("local model registry", () => {
  it("has only the operator's models enabled, as free Ollama models", () => {
    const enabled = registry.getAll().filter((m) => m.enabled);
    expect(enabled.map((m) => m.modelId).sort()).toEqual(["qwen3:4b", "qwen3:8b"]);
    for (const m of enabled) {
      expect(m.provider).toBe("ollama");
      expect(m.costPer1kInput).toBe(0);
      expect(m.costPer1kOutput).toBe(0);
      expect(m.contextWindow).toBe(16384);
      expect(m.maxTokens).toBe(2048);
    }
    expect(registry.get("gpt-5.2")?.enabled).toBe(false);
  });
});

describe("local router", () => {
  const expected: Record<SurvivalTier, string> = {
    high: "qwen3:8b",
    normal: "qwen3:8b",
    low_compute: "qwen3:4b",
    critical: "qwen3:4b",
    dead: "qwen3:4b",
  };

  for (const [tier, model] of Object.entries(expected)) {
    it(`routes tier ${tier} to ${model}`, () => {
      expect(router().selectModel(tier as SurvivalTier, "agent_turn")?.modelId).toBe(model);
    });
  }

  it("ignores paid models even if something re-enables them", () => {
    db.prepare("UPDATE model_registry SET enabled = 1").run();
    for (const tier of Object.keys(expected) as SurvivalTier[]) {
      expect(router().selectModel(tier, "agent_turn")?.provider).toBe("ollama");
    }
  });

  it("returns no model rather than falling back when the operator models are missing", () => {
    db.prepare("UPDATE model_registry SET enabled = 0 WHERE provider = 'ollama'").run();
    db.prepare("UPDATE model_registry SET enabled = 1 WHERE provider != 'ollama'").run();
    expect(router().selectModel("high", "agent_turn")).toBeNull();
  });

  it("route() calls inference with the operator model and token limit", async () => {
    const calls: any[] = [];
    const result = await router().route(
      { messages: [{ role: "user", content: "hi" }], taskType: "agent_turn", tier: "normal", sessionId: "s" },
      async (_messages, options) => {
        calls.push(options);
        return { message: { content: "ok" }, usage: { promptTokens: 10, completionTokens: 2 }, finishReason: "stop" };
      },
    );
    expect(calls[0].model).toBe("qwen3:8b");
    expect(calls[0].maxTokens).toBe(2048);
    expect(result.costCents).toBe(0);
  });

  it("non-local routers still use the routing matrix (upstream behaviour unchanged)", () => {
    db.prepare("UPDATE model_registry SET enabled = 1").run();
    expect(router(false).selectModel("high", "agent_turn")?.provider).not.toBe("ollama");
  });
});

describe("local provider registry (orchestration)", () => {
  const providers = ProviderRegistry.localOnly({
    baseUrl: "http://ollama-gw:11434",
    model: "qwen3:8b",
    lowComputeModel: "qwen3:4b",
    contextWindow: 16384,
    maxOutputTokens: 2048,
  });

  it("has exactly one provider: the gateway", () => {
    const all = providers.getProviders();
    expect(all).toHaveLength(1);
    expect(all[0].baseUrl).toBe("http://ollama-gw:11434/v1");
  });

  it("resolves every tier to the gateway with no fallback candidates", () => {
    for (const tier of ["reasoning", "fast", "cheap"] as const) {
      for (const survival of [false, true]) {
        const candidates = providers.resolveCandidates(tier, survival);
        expect(candidates.length, `${tier}/${survival}`).toBeGreaterThan(0);
        for (const c of candidates) {
          expect(c.provider.id).toBe("local");
          expect(c.client.baseURL).toBe("http://ollama-gw:11434/v1");
        }
      }
    }
    expect(providers.resolveModel("cheap").model.id).toBe("qwen3:4b");
    expect(providers.resolveModel("reasoning").model.id).toBe("qwen3:8b");
  });
});
