import { readFileSync, statSync } from "node:fs";

import { isWorkspaceResult, resolveInWorkspace } from "./workspace.js";
import { toolError, toolOk, type Tool, type ToolResult } from "./tools.js";

const MAX_FILE_BYTES = 1_000_000;

export const readFileTool: Tool = {
  access: "read",
  kind: "read",
  schema: {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the working directory. " +
      "Optional start_line and end_line are 1-based and inclusive. " +
      "Output is capped. Paths outside the working directory are refused, including symlinks that point out.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory." },
        start_line: { type: "integer", description: "First line to return, 1-based." },
        end_line: { type: "integer", description: "Last line to return, 1-based and inclusive." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  execute(args, ctx) {
    return readFile(args, ctx);
  },
};

export async function readFile(args: Record<string, unknown>, ctx: { cwd: string; maxOutputChars: number }): Promise<ToolResult> {
  if (typeof args.path !== "string") {
    return toolError("invalid_arguments", 'read_file requires a string "path".');
  }
  const range = lineRange(args);
  if ("isError" in range) return range;

  const resolved = resolveInWorkspace(ctx.cwd, args.path);
  if (isWorkspaceResult(resolved)) return resolved;

  let info;
  try {
    info = statSync(resolved.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return toolError("not_found", `file not found: ${args.path}`);
    return toolError("io_error", `cannot stat ${args.path}: ${(err as Error).message}`);
  }
  if (info.isDirectory()) return toolError("is_a_directory", `path is a directory: ${args.path}`);
  if (!range.hasRange && info.size > MAX_FILE_BYTES) {
    return toolError(
      "invalid_arguments",
      `file is ${info.size} bytes. Pass start_line and end_line to read a slice. Cap without a range is ${MAX_FILE_BYTES} bytes.`,
    );
  }
  if (info.size > MAX_FILE_BYTES * 8) {
    return toolError("invalid_arguments", `file is too large to read (${info.size} bytes).`);
  }

  const text = readFileSync(resolved.path, "utf8");
  if (text.includes("\0")) return toolError("io_error", `file looks binary: ${args.path}`);

  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const start = range.start;
  const end = range.end ?? lines.length;
  if (start > lines.length) {
    return toolError("invalid_arguments", `start_line ${start} is past the end of ${args.path} (${lines.length} lines).`);
  }
  if (end > lines.length) {
    return toolError("invalid_arguments", `end_line ${end} is past the end of ${args.path} (${lines.length} lines).`);
  }

  const slice = lines.slice(start - 1, end);
  const width = String(end).length;
  let body = slice.map((line, index) => `${String(start + index).padStart(width, " ")}|${line}`).join("\n");
  if (body.length === 0) body = "(empty file)";
  if (body.length > ctx.maxOutputChars) {
    body = `${body.slice(0, ctx.maxOutputChars)}\n[output truncated to ${ctx.maxOutputChars} characters]`;
  }
  return toolOk(body);
}

function lineRange(args: Record<string, unknown>): { hasRange: boolean; start: number; end?: number } | ToolResult {
  const start = args.start_line;
  const end = args.end_line;
  if (start === undefined && end === undefined) return { hasRange: false, start: 1 };
  if (start !== undefined && !isLineNumber(start)) {
    return toolError("invalid_arguments", "start_line must be a positive integer.");
  }
  if (end !== undefined && !isLineNumber(end)) {
    return toolError("invalid_arguments", "end_line must be a positive integer.");
  }
  const startLine = typeof start === "number" ? start : 1;
  const endLine = typeof end === "number" ? end : undefined;
  if (endLine !== undefined && endLine < startLine) {
    return toolError("invalid_arguments", "end_line must be greater than or equal to start_line.");
  }
  return { hasRange: true, start: startLine, ...(endLine !== undefined ? { end: endLine } : {}) };
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
