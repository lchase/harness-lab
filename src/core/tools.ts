import type { ToolCall, ToolSchema } from "../provider/types.js";

export interface ToolContext {
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface Tool {
  schema: ToolSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Run one tool call. A missing tool or a thrown executor becomes a result.
 * The loop appends that result and keeps going.
 */
export async function executeTool(
  tools: readonly Tool[],
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.schema.name === call.name);
  if (!tool) {
    return { output: `Error: unknown tool "${call.name}".`, isError: true };
  }

  try {
    return await tool.execute(call.arguments, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: `Error: ${message}`, isError: true };
  }
}
