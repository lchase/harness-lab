import { spawn } from "node:child_process";

import type { Tool, ToolContext, ToolResult } from "./tools.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 16_000;

export const bashTool: Tool = {
  schema: {
    name: "bash",
    description:
      "Run a bash command in the working directory. stdout and stderr are combined. " +
      "The command is killed if it runs too long or writes too much.",
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
    return Promise.resolve({
      output: 'Error: bash requires a non-empty string argument "command".',
      isError: true,
    });
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
      finish({ output: "Error: failed to capture command output.", isError: true });
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
      finish({ output: `Error: ${err.message}`, isError: true });
    });

    child.on("close", (code, signal) => {
      let text = output;
      if (truncated) {
        text += `\n[output truncated to ${ctx.maxOutputChars} characters]`;
      }
      if (timedOut) {
        text += `\nError: command timed out after ${ctx.timeoutMs}ms`;
        finish({ output: text, isError: true });
        return;
      }
      if (truncated) {
        finish({ output: text.length > 0 ? text : "(no output)", isError: false });
        return;
      }
      if (code !== 0) {
        const signalNote = signal ? `, signal ${signal}` : "";
        text += `\n[exit code ${code ?? "null"}${signalNote}]`;
        finish({ output: text, isError: true });
        return;
      }
      finish({ output: text.length > 0 ? text : "(no output)", isError: false });
    });
  });
}
