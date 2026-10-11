/**
 * What the loop reports while it runs.
 * The core never prints these. A caller (the CLI, later a TUI) decides how
 * they look.
 */

import type { ToolKind } from "./tools.js";

export type StopReason = "completed" | "max_turns" | "provider_error";

/**
 * Lifecycle of one tool call.
 * `completed` and `failed` use the Agent Client Protocol status names.
 * `requested` lines up with ACP `pending`. `running` lines up with ACP `in_progress`.
 * ACP models the permission step as its own request. Here that step is
 * `awaiting_approval`, and a rejection is `denied`.
 */
export type ToolCallStatus =
  | "requested"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "denied";

export type AgentEvent =
  | { type: "assistant_text"; turn: number; text: string }
  | {
      type: "tool_call";
      turn: number;
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      /**
       * One status change. Shaped like an ACP tool_call update:
       * id, title, kind, status, and the raw input or output when this step has it.
       */
      type: "tool_call_update";
      turn: number;
      id: string;
      name: string;
      title: string;
      kind: ToolKind;
      status: ToolCallStatus;
      rawInput?: Record<string, unknown>;
      rawOutput?: string;
    }
  | {
      type: "tool_result";
      turn: number;
      id: string;
      name: string;
      output: string;
      isError: boolean;
    }
  | { type: "turn_end"; turn: number; hadToolCalls: boolean }
  | { type: "stop"; turn: number; reason: StopReason; error?: string };

export type EventHandler = (event: AgentEvent) => void;
