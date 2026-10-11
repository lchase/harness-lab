import { readFileSync, statSync, writeFileSync } from "node:fs";

import { isWorkspaceResult, resolveInWorkspace } from "./workspace.js";
import { toolError, toolOk, type Tool, type ToolResult } from "./tools.js";

export const editFileTool: Tool = {
  access: "write",
  kind: "edit",
  schema: {
    name: "edit_file",
    description:
      "Replace one exact snippet in a UTF-8 file inside the working directory. " +
      "old_string must match exactly once. Zero matches and multiple matches both fail, and the file is left unchanged. " +
      "Paths outside the working directory are refused, including symlinks that point out.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory." },
        old_string: { type: "string", description: "Exact text to replace. Must occur once." },
        new_string: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  execute(args, ctx) {
    return editFile(args, ctx);
  },
};

export async function editFile(args: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
  if (typeof args.path !== "string") return toolError("invalid_arguments", 'edit_file requires a string "path".');
  if (typeof args.old_string !== "string" || args.old_string.length === 0) {
    return toolError("invalid_arguments", 'edit_file requires a non-empty string "old_string".');
  }
  if (typeof args.new_string !== "string") {
    return toolError("invalid_arguments", 'edit_file requires a string "new_string".');
  }
  if (args.old_string === args.new_string) {
    return toolError("invalid_arguments", "old_string and new_string are the same.");
  }

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

  const text = readFileSync(resolved.path, "utf8");
  if (text.includes("\0")) return toolError("io_error", `file looks binary: ${args.path}`);

  const count = countOccurrences(text, args.old_string);
  if (count === 0) {
    return toolError("edit_no_match", `old_string was not found in ${args.path}.`);
  }
  if (count > 1) {
    return toolError(
      "edit_ambiguous",
      `old_string matched ${count} times in ${args.path}. Provide a longer snippet that matches once.`,
    );
  }

  const next = text.replace(args.old_string, args.new_string);
  try {
    writeFileSync(resolved.path, next, "utf8");
  } catch (err) {
    return toolError("io_error", `cannot write ${args.path}: ${(err as Error).message}`);
  }
  return toolOk(`Edited ${args.path} (1 replacement).`);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
  return count;
}
