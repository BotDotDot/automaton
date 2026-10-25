/**
 * Ollama native /api/chat backend (local mode).
 *
 * Native rather than /v1/chat/completions so every request can carry
 * num_ctx (Ollama's default context is sized to VRAM, 4096 on an 8 GB card,
 * and silently truncates longer prompts) and think:false for thinking models.
 *
 * Translates between the runtime's OpenAI-style messages (tool call
 * arguments as JSON strings, tool results linked by tool_call_id) and
 * Ollama's native format (arguments as objects, tool results by tool_name).
 */

import { ulid } from "ulid";
import type {
  ChatMessage,
  InferenceResponse,
  InferenceToolCall,
  InferenceToolDefinition,
} from "../types.js";
import type { ResilientHttpClient } from "../conway/http-client.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("ollama.chat");

export const LOCAL_INFERENCE_TIMEOUT_MS = 300_000;

export interface OllamaChatParams {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  numCtx: number;
  numPredict: number;
  think: boolean;
  temperature?: number;
}

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Runtime messages -> Ollama native messages. */
export function toOllamaMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const toolNames = new Map<string, string>();
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) toolNames.set(tc.id, tc.function.name);
      return {
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls.map((tc) => ({
          function: { name: tc.function.name, arguments: parseArguments(tc.function.arguments) },
        })),
      };
    }
    if (msg.role === "tool") {
      const name = msg.name ?? (msg.tool_call_id ? toolNames.get(msg.tool_call_id) : undefined);
      return { role: "tool", content: msg.content ?? "", ...(name ? { tool_name: name } : {}) };
    }
    return { role: msg.role, content: msg.content ?? "" };
  });
}

/** Strip any <think>...</think> block a thinking model leaves in content. */
export function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

/** Ollama native response -> runtime InferenceResponse. */
export function fromOllamaResponse(data: any, model: string): InferenceResponse {
  const message = data?.message ?? {};
  const rawCalls: OllamaToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: InferenceToolCall[] | undefined = rawCalls.length
    ? rawCalls.map((tc) => ({
        id: tc.id || `call_${ulid()}`,
        type: "function" as const,
        function: {
          name: tc.function?.name ?? "",
          arguments:
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        },
      }))
    : undefined;

  const promptTokens = Number(data?.prompt_eval_count) || 0;
  const completionTokens = Number(data?.eval_count) || 0;
  return {
    id: data?.created_at ? `ollama-${data.created_at}` : `ollama-${ulid()}`,
    model: data?.model || model,
    message: {
      role: "assistant",
      content: stripThinking(typeof message.content === "string" ? message.content : ""),
      tool_calls: toolCalls,
    },
    toolCalls,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    finishReason: toolCalls ? "tool_calls" : data?.done_reason || "stop",
  };
}

export function buildOllamaRequest(params: OllamaChatParams): Record<string, unknown> {
  const options: Record<string, unknown> = {
    num_ctx: params.numCtx,
    num_predict: params.numPredict,
  };
  if (params.temperature !== undefined) options.temperature = params.temperature;
  const body: Record<string, unknown> = {
    model: params.model,
    messages: toOllamaMessages(params.messages),
    stream: false,
    think: params.think,
    options,
  };
  if (params.tools?.length) body.tools = params.tools;
  return body;
}

export async function chatViaOllamaNative(
  params: OllamaChatParams,
  httpClient: ResilientHttpClient,
): Promise<InferenceResponse> {
  const resp = await httpClient.request(`${params.baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOllamaRequest(params)),
    timeout: LOCAL_INFERENCE_TIMEOUT_MS,
  });
  if (!resp.ok) {
    throw new Error(`Inference error (ollama): ${resp.status}: ${await resp.text()}`);
  }
  const result = fromOllamaResponse(await resp.json(), params.model);
  if (result.usage.promptTokens >= params.numCtx - params.numPredict) {
    logger.warn(
      `Prompt used ${result.usage.promptTokens} of ${params.numCtx} context tokens; Ollama may have truncated it.`,
    );
  }
  return result;
}
