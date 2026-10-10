import type { Message, Provider, ToolCall } from "../provider/types.js";
import type { Approver } from "./approval.js";
import { allowAll } from "./approval.js";
import { DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS } from "./bash.js";
import type { AgentEvent, EventHandler, StopReason } from "./events.js";
import type { SessionLog } from "./session.js";
import type { Tool, ToolResult } from "./tools.js";
import { executeTool } from "./tools.js";

export const DEFAULT_MAX_TURNS = 8;

export interface LoopOptions {
  provider: Provider;
  model: string;
  /** Mutated: each assistant reply and tool result is appended. */
  messages: Message[];
  tools: readonly Tool[];
  cwd: string;
  maxTurns?: number;
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Phase 1 default is `allowAll`. Phase 2 passes a real gate here. */
  approve?: Approver;
  onEvent?: EventHandler;
  session?: SessionLog;
}

export interface LoopResult {
  stopReason: StopReason;
  /** Model calls that returned. A provider error does not count. */
  turns: number;
  messages: Message[];
  error?: string;
}

/**
 * One user prompt in, events out.
 *
 * Each turn sends the whole message list and the tool schemas to the provider.
 * Tool calls run one at a time. Their results are appended, and the loop calls
 * the model again. The loop stops when a reply has no tool calls, or when
 * `maxTurns` model calls have been made.
 *
 * This module prints nothing. Callers pass `onEvent`.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    provider,
    model,
    messages,
    tools,
    cwd,
    maxTurns = DEFAULT_MAX_TURNS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    approve = allowAll,
    onEvent,
    session,
  } = options;

  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new Error("maxOutputChars must be a positive integer.");
  }

  const emit = (event: AgentEvent): void => {
    session?.appendEvent(event);
    onEvent?.(event);
  };

  // Phase 4 resume will load history from the log instead of appending it again.
  const seedCount = messages.length;
  for (let i = 0; i < seedCount; i++) {
    const message = messages[i];
    if (message) session?.appendMessage(message);
  }

  const schemas = tools.map((tool) => tool.schema);

  for (let turn = 1; turn <= maxTurns; turn++) {
    let responseMessage: Message;
    try {
      const response = await provider.complete({ model, messages, tools: schemas });
      responseMessage = response.message;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit({ type: "stop", turn, reason: "provider_error", error });
      return { stopReason: "provider_error", turns: turn - 1, messages, error };
    }

    messages.push(responseMessage);
    session?.appendMessage(responseMessage);

    if (responseMessage.role === "assistant" && responseMessage.content.length > 0) {
      emit({ type: "assistant_text", turn, text: responseMessage.content });
    }

    const calls = responseMessage.role === "assistant" ? (responseMessage.toolCalls ?? []) : [];
    if (calls.length === 0) {
      emit({ type: "turn_end", turn, hadToolCalls: false });
      emit({ type: "stop", turn, reason: "completed" });
      return { stopReason: "completed", turns: turn, messages };
    }

    for (const call of calls) {
      emit({
        type: "tool_call",
        turn,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      const result = await runToolCall(call, { tools, cwd, timeoutMs, maxOutputChars, approve });
      const toolMessage: Message = {
        role: "tool",
        content: result.output,
        toolCallId: call.id,
        name: call.name,
      };
      messages.push(toolMessage);
      session?.appendMessage(toolMessage);
      emit({
        type: "tool_result",
        turn,
        id: call.id,
        name: call.name,
        output: result.output,
        isError: result.isError,
      });
    }

    emit({ type: "turn_end", turn, hadToolCalls: true });
  }

  emit({ type: "stop", turn: maxTurns, reason: "max_turns" });
  return { stopReason: "max_turns", turns: maxTurns, messages };
}

interface RunToolCallOptions {
  tools: readonly Tool[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  approve: Approver;
}

async function runToolCall(call: ToolCall, options: RunToolCallOptions): Promise<ToolResult> {
  if (call.argumentsError) {
    return { output: `Error: ${call.argumentsError}`, isError: true };
  }

  // Approval seam. Phase 1's approver is `allowAll`. A denial comes back as a
  // tool result so the model sees it on the next turn.
  const decision = await options.approve({ call, cwd: options.cwd });
  if (!decision.allowed) {
    return { output: `Error: tool call denied. ${decision.reason}`, isError: true };
  }

  return executeTool(options.tools, call, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
  });
}
