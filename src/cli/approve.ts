import type { Readable, Writable } from "node:stream";

import type { ApprovalPrompt, ApprovalPromptChoice, ApprovalPromptRequest } from "../core/approval.js";

/**
 * Ask on stdin. y = once, a = this tool for the session, p = this bash
 * prefix for the session, n = deny (then a reason).
 *
 * Lines are queued as they arrive. Readline's question() drops a line that
 * shows up before the next question is registered, and it closes the
 * interface on EOF, so a deny (two answers on a short stream) throws
 * ERR_USE_AFTER_CLOSE. A small queue keeps both answers.
 */
export const askOnStdin: ApprovalPrompt = (request) => askApproval(request);

export async function askApproval(
  request: ApprovalPromptRequest,
  streams?: { input: Readable; output: Writable },
): Promise<ApprovalPromptChoice> {
  const input = streams?.input ?? process.stdin;
  const output = streams?.output ?? process.stdout;
  const reader = createLineReader(input);
  const ask = async (text: string): Promise<string | null> => {
    output.write(text);
    return reader.readLine();
  };

  const lines = promptLines(request);
  try {
    for (;;) {
      const raw = await ask(`${lines}\n> `);
      if (raw === null) return { choice: "deny", reason: "approval input closed" };
      const answer = raw.trim().toLowerCase();
      if (answer === "y" || answer === "yes") return { choice: "allow_once" };
      if (answer === "a" || answer === "always" || answer === "tool") return { choice: "allow_always_tool" };
      if ((answer === "p" || answer === "prefix") && request.bashPrefix) {
        return { choice: "allow_always_prefix" };
      }
      if (answer === "n" || answer === "no") {
        const reasonRaw = await ask("Reason: ");
        const reason = (reasonRaw ?? "").trim();
        return { choice: "deny", reason: reason.length > 0 ? reason : "denied by user" };
      }
      output.write("Enter y, a, p, or n.\n");
    }
  } finally {
    reader.close();
  }
}

function createLineReader(input: Readable): { readLine: () => Promise<string | null>; close: () => void } {
  const queue: string[] = [];
  let buffer = "";
  let ended = false;
  let waiter: ((line: string | null) => void) | null = null;

  const pushLine = (line: string) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(line);
      return;
    }
    queue.push(line);
  };

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      pushLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  };

  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (buffer.length > 0) {
      pushLine(buffer.replace(/\r$/, ""));
      buffer = "";
    }
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  };

  input.on("data", onData);
  input.on("end", onEnd);
  if (input.readableEnded) onEnd();
  else input.resume();

  return {
    readLine() {
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    close() {
      input.off("data", onData);
      input.off("end", onEnd);
      if (input !== process.stdin) return;
      input.pause();
    },
  };
}

function promptLines(request: ApprovalPromptRequest): string {
  const command = request.call.arguments.command;
  const path = request.call.arguments.path;
  const detail =
    typeof command === "string" ? command : typeof path === "string" ? path : JSON.stringify(request.call.arguments);
  const lines = [
    `Approval needed: ${request.call.name}`,
    `  ${detail}`,
    "  y  allow once",
    `  a  allow ${request.call.name} for the rest of this session`,
  ];
  if (request.bashPrefix) {
    lines.push(`  p  allow commands starting with "${request.bashPrefix}" for the rest of this session`);
  }
  lines.push("  n  deny");
  return lines.join("\n");
}
