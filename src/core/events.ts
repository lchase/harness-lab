/**
 * What the loop reports while it runs.
 * The core never prints these. A caller (the CLI, later a TUI) decides how
 * they look.
 */

export type StopReason = "completed" | "max_turns" | "provider_error";

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
