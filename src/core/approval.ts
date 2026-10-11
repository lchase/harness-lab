import type { ToolCall } from "../provider/types.js";

/**
 * Approval seam.
 *
 * Phase 1 allows every tool call. Phase 2 replaces `allowAll` with a check
 * that can ask the user or apply a permission mode.
 *
 * Return a decision. Do not throw. A denial is a tool result: `runToolCall`
 * in the loop writes it into the conversation so the model can react.
 */

export interface ApprovalRequest {
  call: ToolCall;
  cwd: string;
}

export type ApprovalDecision = { allowed: true } | { allowed: false; reason: string };

export type Approver = (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;

export const allowAll: Approver = () => ({ allowed: true });
