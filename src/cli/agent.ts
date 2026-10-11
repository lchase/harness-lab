import { bashTool } from "../core/bash.js";
import type { Tool } from "../core/tools.js";

/**
 * The concrete agent: which tools exist, and the system prompt.
 * The loop does not know this text. It only receives the messages and tools
 * `main` hands it.
 */
export function createAgentTools(): Tool[] {
  return [bashTool];
}

export function systemPrompt(cwd: string): string {
  return [
    "You are a coding agent running inside a local harness.",
    "You can run shell commands with the bash tool.",
    `The working directory is ${cwd}.`,
    "Use the tool when you need to inspect or change the machine.",
    "When you are done, reply with a concise answer and do not call any tools.",
  ].join("\n");
}
