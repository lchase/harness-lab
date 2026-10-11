import { randomUUID } from "node:crypto";

import type {
  AssistantMessage,
  Message,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolSchema,
} from "./types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  /** Origin plus `/api/v1`, with no `/chat/completions` suffix. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * OpenAI-compatible chat completions on OpenRouter, including tool calls.
 * Transport failures throw. The loop turns that throw into a `provider_error` stop.
 */
export class OpenRouterProvider implements Provider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("OPENROUTER_API_KEY is not set.");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toWireMessages(request.messages),
    };
    if (request.tools.length > 0) {
      body.tools = toWireTools(request.tools);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "x-title": "harness-lab",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`OpenRouter request failed: ${errorMessage(err)}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new Error("OpenRouter response was not JSON.");
    }

    return { message: fromWireMessage(payload) };
  }
}

export function toWireMessages(messages: readonly Message[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
      case "user":
        return { role: message.role, content: message.content };
      case "assistant": {
        const toolCalls = message.toolCalls ?? [];
        return {
          role: "assistant",
          content: message.content.length > 0 ? message.content : null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                  },
                })),
              }
            : {}),
        };
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      default: {
        const unreachable: never = message;
        throw new Error(`Unknown message role: ${JSON.stringify(unreachable)}`);
      }
    }
  });
}

export function toWireTools(tools: readonly ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function fromWireMessage(payload: unknown): AssistantMessage {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenRouter response was not an object.");
  }

  const record = payload as { choices?: unknown; error?: { message?: unknown } };
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    const detail = typeof record.error?.message === "string" ? `: ${record.error.message}` : "";
    throw new Error(`OpenRouter response had no choices${detail}.`);
  }

  const choice = record.choices[0];
  if (!choice || typeof choice !== "object") {
    throw new Error("OpenRouter response choice was empty.");
  }

  const message = (choice as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new Error("OpenRouter response had no message.");
  }

  const wire = message as { content?: unknown; tool_calls?: unknown };
  const content = contentToString(wire.content);
  const toolCalls = parseToolCalls(wire.tool_calls);

  return {
    role: "assistant",
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("OpenRouter tool_calls was not an array.");
  }

  return raw.map((entry) => {
    const call = entry && typeof entry === "object" ? (entry as { id?: unknown; function?: unknown }) : {};
    const fn =
      call.function && typeof call.function === "object"
        ? (call.function as { name?: unknown; arguments?: unknown })
        : {};
    const parsed = parseArguments(fn.arguments);
    const id = typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${randomUUID()}`;
    const name = typeof fn.name === "string" ? fn.name : "";
    return {
      id,
      name,
      arguments: parsed.arguments,
      ...(parsed.argumentsError ? { argumentsError: parsed.argumentsError } : {}),
    };
  });
}

function parseArguments(raw: unknown): Pick<ToolCall, "arguments" | "argumentsError"> {
  if (typeof raw === "string") {
    try {
      return asObjectArgs(JSON.parse(raw) as unknown);
    } catch (err) {
      return {
        arguments: {},
        argumentsError: `Tool arguments were not valid JSON: ${errorMessage(err)}`,
      };
    }
  }
  if (raw == null) {
    return { arguments: {} };
  }
  return asObjectArgs(raw);
}

function asObjectArgs(value: unknown): Pick<ToolCall, "arguments" | "argumentsError"> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { arguments: value as Record<string, unknown> };
  }
  return { arguments: {}, argumentsError: "Tool arguments must be a JSON object." };
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
