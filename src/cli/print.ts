import type { AgentEvent } from "../core/events.js";

/** Plain console lines. This is the only place phase 1 renders events. */
export function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "assistant_text":
      console.log(`[turn ${event.turn}] assistant: ${event.text.trimEnd()}`);
      return;
    case "tool_call":
      console.log(
        `[turn ${event.turn}] tool_call ${event.name} ${event.id} ${JSON.stringify(event.arguments)}`,
      );
      return;
    case "tool_result":
      console.log(
        `[turn ${event.turn}] tool_result ${event.name} ${event.id} ${event.isError ? "error" : "ok"}`,
      );
      console.log(event.output.trimEnd());
      return;
    case "turn_end":
      console.log(`[turn ${event.turn}] turn_end tools=${event.hadToolCalls ? "yes" : "no"}`);
      return;
    case "stop": {
      const detail = event.error ? ` (${event.error})` : "";
      console.log(`[stop] ${event.reason} turn=${event.turn}${detail}`);
      return;
    }
    default: {
      const unreachable: never = event;
      throw new Error(`Unknown event: ${JSON.stringify(unreachable)}`);
    }
  }
}
