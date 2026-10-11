import type { ToolCall, ToolSchema } from "../provider/types.js";

/** ACP tool kinds, the subset this harness uses. */
export type ToolKind = "read" | "edit" | "search" | "execute" | "other";

/**
 * read is auto-approved.
 * write and execute ask for approval.
 */
export type ToolAccess = "read" | "write" | "execute";

export type ToolErrorCode =
  | "invalid_arguments"
  | "unknown_tool"
  | "path_escape"
  | "not_found"
  | "is_a_directory"
  | "edit_no_match"
  | "edit_ambiguous"
  | "timeout"
  | "command_failed"
  | "denied"
  | "io_error";

export interface ToolContext {
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
}

/**
 * A tool failure is this object. Executors return it. They do not throw
 * out of the loop. `executeTool` also catches a throw and turns it into one.
 */
export interface ToolResult {
  output: string;
  isError: boolean;
  code?: ToolErrorCode;
}

export interface Tool {
  schema: ToolSchema;
  access: ToolAccess;
  kind: ToolKind;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function toolOk(output: string): ToolResult {
  return { isError: false, output };
}

export function toolError(code: ToolErrorCode, message: string, extra?: string): ToolResult {
  const tail = extra && extra.length > 0 ? `\n${extra}` : "";
  return { isError: true, code, output: `Error (${code}): ${message}${tail}` };
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
    return toolError("unknown_tool", `unknown tool "${call.name}".`);
  }

  try {
    return await tool.execute(call.arguments, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError("io_error", message);
  }
}
