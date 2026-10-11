import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { toolError, type ToolResult } from "./tools.js";

/**
 * Resolve `userPath` against the working folder and refuse anything that
 * lands outside it. Symlinks are resolved a component at a time. A link
 * whose target is outside the folder is a refusal, even when the link
 * itself sits inside the folder.
 *
 * bash does not use this. It is not sandboxed. That is phase 6.
 */

export function resolveInWorkspace(cwd: string, userPath: string): ToolResult | { ok: true; path: string } {
  if (userPath.trim().length === 0 || userPath.includes("\0")) {
    return toolError("invalid_arguments", "path must be a non-empty string.");
  }

  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return toolError("io_error", `working directory is not available: ${cwd}`);
  }

  const lexical = resolve(root, userPath);
  if (escapes(root, lexical)) {
    return toolError("path_escape", `path escapes the workspace: ${userPath}`);
  }

  const rel = relative(root, lexical);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = root;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || part === "" || part === "." || part === "..") {
      return toolError("path_escape", `path escapes the workspace: ${userPath}`);
    }

    const next = join(current, part);
    let info;
    try {
      info = lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const rest = join(current, ...parts.slice(i));
        if (escapes(root, rest)) {
          return toolError("path_escape", `path escapes the workspace: ${userPath}`);
        }
        return { ok: true, path: rest };
      }
      return toolError("io_error", `cannot stat path: ${userPath}`);
    }

    if (info.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(next);
      } catch {
        return toolError("path_escape", `symlink escapes the workspace: ${userPath}`);
      }
      if (escapes(root, target)) {
        return toolError("path_escape", `symlink escapes the workspace: ${userPath}`);
      }
      current = target;
      continue;
    }

    current = next;
  }

  try {
    const real = realpathSync(current);
    if (escapes(root, real)) {
      return toolError("path_escape", `path escapes the workspace: ${userPath}`);
    }
    return { ok: true, path: real };
  } catch {
    return { ok: true, path: current };
  }
}

export function isWorkspaceResult(value: ToolResult | { ok: true; path: string }): value is ToolResult {
  return "isError" in value;
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
