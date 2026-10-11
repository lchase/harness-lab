import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isWorkspaceResult, resolveInWorkspace } from "./workspace.js";
import { toolError, toolOk, type Tool, type ToolResult } from "./tools.js";

export const writeFileTool: Tool = {
  access: "write",
  kind: "edit",
  schema: {
    name: "write_file",
    description:
      "Create or overwrite a UTF-8 text file inside the working directory. " +
      "Parent directories are created. Paths outside the working directory are refused, including symlinks that point out.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory." },
        content: { type: "string", description: "Full new contents of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  execute(args, ctx) {
    return writeFile(args, ctx);
  },
};

export async function writeFile(args: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
  if (typeof args.path !== "string") return toolError("invalid_arguments", 'write_file requires a string "path".');
  if (typeof args.content !== "string") {
    return toolError("invalid_arguments", 'write_file requires a string "content".');
  }

  const resolved = resolveInWorkspace(ctx.cwd, args.path);
  if (isWorkspaceResult(resolved)) return resolved;

  try {
    const info = statSync(resolved.path);
    if (info.isDirectory()) return toolError("is_a_directory", `path is a directory: ${args.path}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return toolError("io_error", `cannot stat ${args.path}: ${(err as Error).message}`);
  }

  try {
    mkdirSync(dirname(resolved.path), { recursive: true });
    writeFileSync(resolved.path, args.content, "utf8");
  } catch (err) {
    return toolError("io_error", `cannot write ${args.path}: ${(err as Error).message}`);
  }
  return toolOk(`Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`);
}
