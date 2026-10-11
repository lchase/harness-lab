import { spawn } from "node:child_process";

import { toolError, toolOk, type Tool, type ToolContext, type ToolResult } from "./tools.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

export const bashTool: Tool = {
  access: "execute",
  kind: "execute",
  schema: {
    name: "bash",
    description:
      "Run a bash command with cwd set to the working directory. stdout and stderr are combined. " +
      "The command is killed if it runs too long or writes too much. " +
      "bash is not sandboxed: it can read and write outside the working directory. File tools cannot. Sandboxing is a later phase.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to run.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  execute(args, ctx) {
    return runBash(args, ctx);
  },
};

/**
 * Run `command` with bash. The child cwd is `ctx.cwd`.
 * Timeout, a non-zero exit, and a bad `command` are results with `isError`.
 * They are not thrown.
 */
export function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = args.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return Promise.resolve(toolError("invalid_arguments", 'bash requires a non-empty string argument "command".'));
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let timedOut = false;
    let truncated = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process has already exited.
        }
      }
    };

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    if (!child.stdout || !child.stderr) {
      kill();
      finish(toolError("io_error", "failed to capture command output."));
      return;
    }

    const append = (chunk: Buffer): void => {
      if (truncated) return;
      const text = chunk.toString("utf8");
      const room = ctx.maxOutputChars - output.length;
      if (text.length > room) {
        output += text.slice(0, Math.max(0, room));
        truncated = true;
        kill();
        return;
      }
      output += text;
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, ctx.timeoutMs);

    child.on("error", (err) => {
      if (timedOut || truncated) return;
      finish(toolError("io_error", err.message));
    });

    child.on("close", (code, signal) => {
      let text = output;
      if (truncated) {
        text += `\n[output truncated to ${ctx.maxOutputChars} characters]`;
      }
      if (timedOut) {
        finish(toolError("timeout", `command timed out after ${ctx.timeoutMs}ms`, text));
        return;
      }
      if (truncated) {
        finish(toolOk(text.length > 0 ? text : "(no output)"));
        return;
      }
      if (code !== 0) {
        const signalNote = signal ? `, signal ${signal}` : "";
        finish(toolError("command_failed", `exit code ${code ?? "null"}${signalNote}`, text));
        return;
      }
      finish(toolOk(text.length > 0 ? text : "(no output)"));
    });
  });
}
