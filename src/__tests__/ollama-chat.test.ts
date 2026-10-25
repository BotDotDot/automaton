/**
 * Local-mode inference: native Ollama /api/chat only, plain HTTP only to
 * the configured gateway, never Conway or a paid provider.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  toOllamaMessages,
  fromOllamaResponse,
  buildOllamaRequest,
  stripThinking,
} from "../ollama/chat.js";
import { createInferenceClient } from "../conway/inference.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import type { ChatMessage, InferenceToolDefinition } from "../types.js";

const GW = "http://ollama-gw:11434";

const TOOLS: InferenceToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "exec",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
];

function ollamaReply(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      model: "qwen3:8b",
      created_at: "2026-10-23T00:00:00Z",
      message: { role: "assistant", content: "", ...message },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 30,
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function localClient(overrides: Record<string, unknown> = {}) {
  return createInferenceClient({
    apiUrl: "https://conway.disabled.invalid",
    apiKey: "",
    defaultModel: "qwen3:8b",
    lowComputeModel: "qwen3:4b",
    maxTokens: 1024,
    ollamaBaseUrl: GW,
    local: { numCtx: 16384, think: false },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("message translation", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: '{"command":"ls"}' } }],
    },
    { role: "tool", content: "a.txt", tool_call_id: "call_1" },
  ];

  it("turns argument strings into objects and links tool results by name", () => {
    const out = toOllamaMessages(history);
    expect(out[2]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "exec", arguments: { command: "ls" } } }],
    });
    expect(out[3]).toEqual({ role: "tool", content: "a.txt", tool_name: "exec" });
  });

  it("survives malformed tool arguments", () => {
    const out = toOllamaMessages([
      { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "exec", arguments: "{oops" } }] },
    ]);
    expect((out[0] as any).tool_calls[0].function.arguments).toEqual({});
  });

  it("builds a request with num_ctx, num_predict, think and tools", () => {
    const body = buildOllamaRequest({
      baseUrl: GW, model: "qwen3:8b", messages: history, tools: TOOLS,
      numCtx: 16384, numPredict: 1024, think: false, temperature: 0.2,
    });
    expect(body).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      think: false,
      options: { num_ctx: 16384, num_predict: 1024, temperature: 0.2 },
      tools: TOOLS,
    });
  });

  it("turns native tool calls into runtime tool calls with ids", () => {
    const r = fromOllamaResponse(
      { message: { content: "", tool_calls: [{ function: { name: "exec", arguments: { command: "pwd" } } }] }, prompt_eval_count: 10, eval_count: 5 },
      "qwen3:8b",
    );
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0].id).toMatch(/^call_/);
    expect(JSON.parse(r.toolCalls![0].function.arguments)).toEqual({ command: "pwd" });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("strips leaked thinking from content", () => {
    expect(stripThinking("<think>hmm</think>\nHello")).toBe("Hello");
    const r = fromOllamaResponse({ message: { content: "<think>x</think>Hi" } }, "m");
    expect(r.message.content).toBe("Hi");
    expect(r.toolCalls).toBeUndefined();
  });
});

describe("local-mode inference client", () => {
  it("sends every request to the gateway's native /api/chat", async () => {
    const fetchMock = vi.fn(async () => ollamaReply({ content: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await localClient().chat([{ role: "user", content: "hi" }], { tools: TOOLS });
    expect(r.message.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GW}/api/chat`);
    const body = JSON.parse(String(init.body));
    expect(body.options.num_ctx).toBe(16384);
    expect(body.think).toBe(false);
    expect(body.tools).toEqual(TOOLS);
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("never routes to Conway or a paid provider, whatever the model name or keys", async () => {
    const fetchMock = vi.fn(async () => ollamaReply({ content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = localClient({
      apiUrl: "https://api.conway.tech",
      apiKey: "cnwy_key",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-ant",
      getModelProvider: (m: string) => (m.startsWith("claude") ? "anthropic" : m.startsWith("gpt") ? "openai" : "conway"),
    });
    for (const model of ["gpt-5.2", "claude-opus-5-5", "o3", "some-conway-model"]) {
      await client.chat([{ role: "user", content: "hi" }], { model });
    }
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls.every((u) => u === `${GW}/api/chat`)).toBe(true);
  });

  it("low-compute mode switches to the operator's small model", async () => {
    const fetchMock = vi.fn(async () => ollamaReply({ content: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = localClient();
    client.setLowComputeMode(true);
    expect(client.getDefaultModel()).toBe("qwen3:4b");
    await client.chat([{ role: "user", content: "hi" }]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.model).toBe("qwen3:4b");
    expect(body.options.num_predict).toBe(1024);
  });

  it("requires an Ollama URL", () => {
    expect(() => localClient({ ollamaBaseUrl: undefined })).toThrow(/Ollama base URL/);
  });

  it("surfaces Ollama errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("model not found", { status: 404 })));
    await expect(localClient().chat([{ role: "user", content: "hi" }])).rejects.toThrow(/ollama.*404/);
  });
});

describe("HTTP origin allowlist", () => {
  it("allows plain HTTP only to the exact allowed origin", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ResilientHttpClient({ allowHttpOrigins: [GW], maxRetries: 0 });
    await expect(client.request(`${GW}/api/tags`)).resolves.toBeInstanceOf(Response);
    for (const url of ["http://ollama-gw:11435/api/tags", "http://evil:11434/api/tags", "http://api.conway.tech/v1"]) {
      await expect(client.request(url), url).rejects.toThrow(/HTTPS required/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("non-local clients still refuse plain HTTP to the gateway", async () => {
    await expect(new ResilientHttpClient().request(`${GW}/api/tags`)).rejects.toThrow(/HTTPS required/);
  });
});
