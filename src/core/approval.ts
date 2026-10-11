import type { ToolCall } from "../provider/types.js";
import type { Tool, ToolAccess } from "./tools.js";

/**
 * Approval policy.
 *
 * Reads (`access: "read"`) are allowed without a prompt.
 * Writes and bash ask through `ask`, which the CLI or a later UI provides.
 * The policy remembers allow-always answers for this session: one tool name,
 * or a bash command prefix.
 *
 * `allowAll` skips the prompt. Tests use it. `--yolo` uses a policy that
 * records the decision as `yolo` instead.
 *
 * Return a decision. Do not throw. A denial is a tool result.
 */

export type ApprovalSource = "auto_read" | "session_rule" | "prompt" | "yolo" | "allow_all";

export type ApprovalScope = "read" | "tool" | "bash_prefix";

export interface ApprovalDetail {
  decision: "allow_once" | "allow_always" | "deny";
  source: ApprovalSource;
  scope?: ApprovalScope;
  prefix?: string;
  reason?: string;
}

export type ApprovalDecision =
  | { allowed: true; detail: ApprovalDetail }
  | { allowed: false; reason: string; detail: ApprovalDetail };

export interface ApprovalPromptRequest {
  call: ToolCall;
  cwd: string;
  access: Extract<ToolAccess, "write" | "execute">;
  /** First token of a bash command. Present when the user can allow a prefix. */
  bashPrefix?: string;
}

export type ApprovalPromptChoice =
  | { choice: "allow_once" }
  | { choice: "allow_always_tool" }
  | { choice: "allow_always_prefix" }
  | { choice: "deny"; reason: string };

export type ApprovalPrompt = (request: ApprovalPromptRequest) => Promise<ApprovalPromptChoice>;

export interface ApprovalRequest {
  call: ToolCall;
  cwd: string;
  tool?: Tool;
  /** Called immediately before `ask` waits. The loop emits `awaiting_approval` here. */
  onAwaitingApproval?: () => void;
}

export type Approver = (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;

export const allowAll: Approver = () => ({
  allowed: true,
  detail: { decision: "allow_once", source: "allow_all" },
});

export function bashCommandPrefix(command: string): string | undefined {
  const token = command.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : undefined;
}

export function commandMatchesPrefix(command: string, prefix: string): boolean {
  const trimmed = command.trim();
  return trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`);
}

export interface ApprovalPolicyOptions {
  ask: ApprovalPrompt;
  /** Auto-approve every call and record the source as `yolo`. */
  yolo?: boolean;
}

export function createApprovalPolicy(options: ApprovalPolicyOptions): Approver {
  const alwaysTools = new Set<string>();
  const prefixes: string[] = [];

  return async (request) => {
    const name = request.call.name;
    const command = stringArg(request.call, "command");
    const prefix = command ? bashCommandPrefix(command) : undefined;

    if (options.yolo) {
      return allow({ decision: "allow_once", source: "yolo" });
    }
    if (request.tool?.access === "read") {
      return allow({ decision: "allow_once", source: "auto_read", scope: "read" });
    }
    if (alwaysTools.has(name)) {
      return allow({ decision: "allow_always", source: "session_rule", scope: "tool" });
    }
    if (request.tool?.access === "execute" && command) {
      const hit = prefixes.find((item) => commandMatchesPrefix(command, item));
      if (hit) {
        return allow({ decision: "allow_always", source: "session_rule", scope: "bash_prefix", prefix: hit });
      }
    }

    const access = request.tool?.access === "write" ? "write" : "execute";
    request.onAwaitingApproval?.();

    let choice: ApprovalPromptChoice;
    try {
      choice = await options.ask({
        call: request.call,
        cwd: request.cwd,
        access,
        ...(prefix ? { bashPrefix: prefix } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return deny(`approval failed: ${message}`);
    }

    if (choice.choice === "allow_once") {
      return allow({ decision: "allow_once", source: "prompt" });
    }
    if (choice.choice === "allow_always_tool") {
      alwaysTools.add(name);
      return allow({ decision: "allow_always", source: "prompt", scope: "tool" });
    }
    if (choice.choice === "allow_always_prefix") {
      if (!prefix) return deny("no command prefix to remember");
      prefixes.push(prefix);
      return allow({ decision: "allow_always", source: "prompt", scope: "bash_prefix", prefix });
    }
    const reason = choice.reason.trim();
    return deny(reason.length > 0 ? reason : "denied by user");
  };
}

function allow(detail: ApprovalDetail): ApprovalDecision {
  return { allowed: true, detail };
}

function deny(reason: string): ApprovalDecision {
  return {
    allowed: false,
    reason,
    detail: { decision: "deny", source: "prompt", reason },
  };
}

function stringArg(call: ToolCall, key: string): string | undefined {
  const value = call.arguments[key];
  return typeof value === "string" ? value : undefined;
}
