/**
 * Local mode end to end (minus the container): real loadConfig() from an
 * operator file, real local inference client, local Conway wrapper and a
 * keyless identity, driving the real agent loop. fetch is faked: the only
 * URLs it may ever see are the Ollama gateway's.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VALID_OPERATOR } from "./fixtures/operator.js";
import { MockConwayClient, createTestDb } from "./mocks.js";
import type { AgentTurn, AutomatonDatabase } from "../types.js";

const GW = VALID_OPERATOR.ollama.baseUrl;

describe("local mode run", () => {
  let home: string;
  let db: AutomatonDatabase;
  const savedEnv = { ...process.env };
  let urls: string[];
  let chatBodies: any[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "local-run-"));
    fs.mkdirSync(path.join(home, ".automaton"));
    const op = path.join(home, "operator.json");
    fs.writeFileSync(op, JSON.stringify(VALID_OPERATOR));
    // Volume config trying to pull the bot onto paid providers.
    fs.writeFileSync(
      path.join(home, ".automaton", "automaton.json"),
      JSON.stringify({ conwayApiKey: "cnwy_x", openaiApiKey: "sk-x", inferenceModel: "gpt-5.2" }),
    );
    fs.writeFileSync(
      path.join(home, ".automaton", "inference-providers.json"),
      JSON.stringify({ providers: [{ id: "evil", baseUrl: "https://api.openai.com/v1", enabled: true, models: [] }] }),
    );
    process.env.HOME = home;
    process.env.AUTOMATON_OPERATOR_CONFIG = op;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.CONWAY_API_KEY;
    vi.resetModules();

    urls = [];
    chatBodies = [];
    let chatCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input?.url ?? input);
      urls.push(url);
      if (url !== `${GW}/api/chat`) {
        return new Response("blocked by test", { status: 403 });
      }
      chatBodies.push(JSON.parse(String(init?.body)));
      chatCalls++;
      const message = chatCalls === 1
        ? { role: "assistant", content: "", tool_calls: [{ function: { name: "exec", arguments: { command: "echo hi" } } }] }
        : { role: "assistant", content: "Done. Sleeping now." };
      return new Response(JSON.stringify({
        model: "qwen3:8b", message, done: true, done_reason: "stop", prompt_eval_count: 500, eval_count: 20,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    db?.close();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    fs.rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("runs turns using only the gateway, with the operator's model", async () => {
    const { loadConfig } = await import("../config.js");
    const { createInferenceClient } = await import("../conway/inference.js");
    const { createLocalConwayClient } = await import("../operator/local-conway.js");
    const { createKeylessIdentity } = await import("../identity/wallet.js");
    const { runAgentLoop } = await import("../agent/loop.js");

    const config = loadConfig()!;
    expect(config.localMode).toBe(true);

    db = createTestDb();
    const sandbox = new MockConwayClient();
    const conway = createLocalConwayClient(sandbox, config.simBalanceCents!);
    const keyless = createKeylessIdentity(config.walletAddress);
    const identity = {
      name: config.name,
      address: keyless.chainIdentity.address as `0x${string}`,
      account: keyless.account,
      creatorAddress: config.creatorAddress as `0x${string}`,
      sandboxId: config.sandboxId,
      apiKey: "",
      createdAt: new Date().toISOString(),
      chainType: "evm" as const,
      chainIdentity: keyless.chainIdentity,
    };
    const inference = createInferenceClient({
      apiUrl: config.conwayApiUrl,
      apiKey: "",
      defaultModel: config.inferenceModel,
      maxTokens: config.maxTokensPerTurn,
      lowComputeModel: config.modelStrategy!.lowComputeModel,
      ollamaBaseUrl: config.ollamaBaseUrl,
      local: { numCtx: config.ollamaNumCtx!, think: config.ollamaThink! },
    });

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      ollamaBaseUrl: config.ollamaBaseUrl,
      onTurnComplete: (t) => turns.push(t),
    });

    expect(chatBodies.length).toBeGreaterThanOrEqual(2);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url, "every request goes to the gateway").toBe(`${GW}/api/chat`);
    const { LOCAL_MODE_TOOLS } = await import("../agent/tools.js");
    for (const body of chatBodies) {
      expect(body.tools.map((t: any) => t.function.name).sort()).toEqual([...LOCAL_MODE_TOOLS].sort());
      expect(body.model).toBe("qwen3:8b");
      expect(body.options.num_ctx).toBe(16384);
      expect(body.think).toBe(false);
    }
    expect(sandbox.execCalls.map((c) => c.command)).toContain("echo hi");
    expect(turns.some((t) => t.toolCalls.some((tc) => tc.name === "exec"))).toBe(true);

    const paidEnabled = db.raw
      .prepare("SELECT COUNT(*) AS n FROM model_registry WHERE enabled = 1 AND provider != 'ollama'")
      .get() as { n: number };
    expect(paidEnabled.n).toBe(0);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("local Conway client: local files/exec work, balance is the placeholder, remote calls throw", async () => {
    const { createLocalConwayClient } = await import("../operator/local-conway.js");
    const sandbox = new MockConwayClient();
    const conway = createLocalConwayClient(sandbox, 2000);
    expect(await conway.getCreditsBalance()).toBe(2000);
    expect((await conway.exec("true")).exitCode).toBe(0);
    await conway.writeFile("/x", "y");
    expect(await conway.readFile("/x")).toBe("y");
    for (const call of [
      () => conway.transferCredits("0x1", 1),
      () => conway.createSandbox({} as any),
      () => conway.listModels(),
      () => conway.registerAutomaton({} as any),
      () => conway.searchDomains("x"),
    ]) {
      await expect(call()).rejects.toThrow(/local mode/);
    }
    expect(() => conway.createScopedClient("x")).toThrow(/local mode/);
  });

  it("keyless identity has the operator address and cannot sign", async () => {
    const { createKeylessIdentity } = await import("../identity/wallet.js");
    const id = createKeylessIdentity(VALID_OPERATOR.identityAddress);
    expect(id.account.address).toBe(VALID_OPERATOR.identityAddress);
    expect(() => id.account.signMessage({ message: "x" })).toThrow(/no private key/);
    await expect(id.chainIdentity.signMessage("x")).rejects.toThrow(/no private key/);
    expect(fs.existsSync(path.join(home, ".automaton", "wallet.json"))).toBe(false);
  });

  it("heartbeat tick uses the placeholder balance and makes no RPC call", async () => {
    const { buildTickContext } = await import("../heartbeat/tick-context.js");
    const { createLocalConwayClient } = await import("../operator/local-conway.js");
    db = createTestDb();
    const ctx = await buildTickContext(
      db.raw,
      createLocalConwayClient(new MockConwayClient(), 2000),
      { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 },
      VALID_OPERATOR.identityAddress,
      "evm",
      { localMode: true },
    );
    expect(ctx.creditBalance).toBe(2000);
    expect(ctx.usdcBalance).toBe(0);
    expect(ctx.survivalTier).toBe("high");
    expect(urls).toEqual([]);
  });
});
