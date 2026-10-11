import { readdirSync } from "node:fs";
import { join } from "node:path";

import { isWorkspaceResult, resolveInWorkspace } from "./workspace.js";
import { toolError, toolOk, type Tool, type ToolResult } from "./tools.js";

const MAX_MATCHES = 200;

export const globTool: Tool = {
  access: "read",
  kind: "search",
  schema: {
    name: "glob",
    description:
      "List files inside the working directory that match a glob pattern. " +
      "* and ? match within one path segment. ** matches across segments. " +
      "Symlink directories are not followed. Results are capped.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Pattern relative to the working directory, for example "src/**/*.ts" or "*".',
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  execute(args, ctx) {
    return glob(args, ctx);
  },
};

export async function glob(args: Record<string, unknown>, ctx: { cwd: string; maxOutputChars: number }): Promise<ToolResult> {
  if (typeof args.pattern !== "string" || args.pattern.trim().length === 0) {
    return toolError("invalid_arguments", 'glob requires a non-empty string "pattern".');
  }
  if (args.pattern.includes("\0") || args.pattern.split("/").includes("..")) {
    return toolError("path_escape", `pattern escapes the workspace: ${args.pattern}`);
  }

  const rootResult = resolveInWorkspace(ctx.cwd, ".");
  if (isWorkspaceResult(rootResult)) return rootResult;

  const matches: string[] = [];
  let truncated = false;
  walk(rootResult.path, "", args.pattern, matches, () => {
    truncated = true;
  });
  matches.sort();

  if (matches.length === 0) return toolOk("(no matches)");
  let body = matches.join("\n");
  if (truncated) body += `\n[results truncated to ${MAX_MATCHES} matches]`;
  if (body.length > ctx.maxOutputChars) {
    body = `${body.slice(0, ctx.maxOutputChars)}\n[output truncated to ${ctx.maxOutputChars} characters]`;
  }
  return toolOk(body);
}

function walk(
  dir: string,
  prefix: string,
  pattern: string,
  matches: string[],
  onCap: () => void,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= MAX_MATCHES) {
      onCap();
      return;
    }
    const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (matchGlob(pattern, rel)) matches.push(`${rel}/`);
      walk(join(dir, entry.name), rel, pattern, matches, onCap);
      continue;
    }
    if (matchGlob(pattern, rel)) matches.push(rel);
  }
}

export function matchGlob(pattern: string, path: string): boolean {
  const parts = pattern.split("/").filter((part) => part.length > 0);
  const segments = path.split("/").filter((part) => part.length > 0);
  return matchParts(parts, segments);
}

function matchParts(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const head = pattern[0];
  if (head === undefined) return false;
  if (head === "**") {
    const rest = pattern.slice(1);
    if (matchParts(rest, path)) return true;
    if (path.length === 0) return false;
    return matchParts(pattern, path.slice(1));
  }
  if (path.length === 0) return false;
  const segment = path[0];
  if (segment === undefined || !segmentMatch(head, segment)) return false;
  return matchParts(pattern.slice(1), path.slice(1));
}

function segmentMatch(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = -1;
  while (ti < text.length) {
    const p = pattern[pi];
    const t = text[ti];
    if (p !== undefined && t !== undefined && (p === "?" || p === t)) {
      pi += 1;
      ti += 1;
      continue;
    }
    if (p === "*") {
      star = pi;
      mark = ti;
      pi += 1;
      continue;
    }
    if (star !== -1) {
      pi = star + 1;
      mark += 1;
      ti = mark;
      continue;
    }
    return false;
  }
  while (pattern[pi] === "*") pi += 1;
  return pi === pattern.length;
}
