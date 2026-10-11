import type { Message, Provider, ToolCall } from "../provider/types.js";
import type { Approver } from "./approval.js";
import { createApprovalPolicy } from "./approval.js";
import { DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS } from "./bash.js";
import type { AgentEvent, EventHandler, StopReason, ToolCallStatus } from "./events.js";
import type { SessionLog } from "./session.js";
import type { Tool, ToolKind, ToolResult } from "./tools.js";
import { executeTool, toolError } from "./tools.js";

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
  /**
   * Defaults to a policy that auto-allows reads and denies writes and bash
   * with "no approver configured". Pass `allowAll` in tests that should run
   * every tool. The CLI passes a policy wired to the prompt or to `--yolo`.
   */
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
    onEvent,
    session,
  } = options;
  const approve =
    options.approve ??
    createApprovalPolicy({
      ask: async () => ({ choice: "deny", reason: "no approver configured" }),
    });

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
      const tool = tools.find((candidate) => candidate.schema.name === call.name);
      const title = toolTitle(call);
      const kind = tool?.kind ?? "other";
      emit({
        type: "tool_call",
        turn,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
      emitStatus(emit, {
        turn,
        id: call.id,
        name: call.name,
        title,
        kind,
        status: "requested",
        rawInput: call.arguments,
      });

      const result = await runToolCall(call, {
        tools,
        tool,
        cwd,
        timeoutMs,
        maxOutputChars,
        approve,
        session,
        onStatus: (status, rawOutput) => {
          emitStatus(emit, {
            turn,
            id: call.id,
            name: call.name,
            title,
            kind,
            status,
            ...(rawOutput !== undefined ? { rawOutput } : {}),
          });
        },
      });

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
  tool: Tool | undefined;
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  approve: Approver;
  session?: SessionLog;
  onStatus: (status: ToolCallStatus, rawOutput?: string) => void;
}

async function runToolCall(call: ToolCall, options: RunToolCallOptions): Promise<ToolResult> {
  if (call.argumentsError) {
    const result = toolError("invalid_arguments", call.argumentsError);
    options.onStatus("failed", result.output);
    return result;
  }
  if (!options.tool) {
    const result = toolError("unknown_tool", `unknown tool "${call.name}".`);
    options.onStatus("failed", result.output);
    return result;
  }

  let decision;
  try {
    decision = await options.approve({
      call,
      cwd: options.cwd,
      tool: options.tool,
      onAwaitingApproval: () => options.onStatus("awaiting_approval"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    decision = {
      allowed: false as const,
      reason: message,
      detail: { decision: "deny" as const, source: "prompt" as const, reason: message },
    };
  }

  options.session?.appendApproval({
    toolCallId: call.id,
    name: call.name,
    ...decision.detail,
    ...(stringArg(call, "path") ? { path: stringArg(call, "path") } : {}),
    ...(stringArg(call, "command") ? { command: stringArg(call, "command") } : {}),
  });

  if (!decision.allowed) {
    const result = toolError("denied", `tool call denied. ${decision.reason}`);
    options.onStatus("denied", result.output);
    return result;
  }

  options.onStatus("running");
  const result = await executeTool(options.tools, call, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputChars: options.maxOutputChars,
  });
  options.onStatus(result.isError ? "failed" : "completed", result.output);
  return result;
}

function emitStatus(
  emit: (event: AgentEvent) => void,
  event: {
    turn: number;
    id: string;
    name: string;
    title: string;
    kind: ToolKind;
    status: ToolCallStatus;
    rawInput?: Record<string, unknown>;
    rawOutput?: string;
  },
): void {
  emit({ type: "tool_call_update", ...event });
}

function toolTitle(call: ToolCall): string {
  const path = stringArg(call, "path");
  if (path) return `${call.name} ${path}`;
  const pattern = stringArg(call, "pattern");
  if (pattern) return `${call.name} ${pattern}`;
  const command = stringArg(call, "command");
  if (command) return `bash ${command}`;
  return call.name;
}

function stringArg(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" ? value : undefined;
}
