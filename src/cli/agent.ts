import { bashTool } from "../core/bash.js";
import { editFileTool } from "../core/edit-file.js";
import { globTool } from "../core/glob.js";
import { readFileTool } from "../core/read-file.js";
import { ToolRegistry } from "../core/registry.js";
import type { Tool } from "../core/tools.js";
import { writeFileTool } from "../core/write-file.js";

/**
 * The concrete agent: which tools exist, and the system prompt.
 * The loop does not know this text. It only receives the messages and tools
 * `main` hands it. Register another tool with `registry.register`.
 */
export function createAgentTools(): Tool[] {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globTool);
  registry.register(bashTool);
  return registry.list();
}

export function systemPrompt(cwd: string): string {
  return [
    "You are a coding agent running inside a local harness.",
    "Tools: read_file, write_file, edit_file, glob, and bash.",
    `The working directory is ${cwd}.`,
    "File tools only touch paths inside that directory. Escapes, including symlinks that point outside, are refused.",
    "bash is not sandboxed. It can affect files outside the working directory. Prefer the file tools when they can do the job.",
    "edit_file replaces one exact snippet. If the snippet is missing or appears more than once, the edit fails and you should retry with more context.",
    "When you are done, reply with a concise answer and do not call any tools.",
  ].join("\n");
}
