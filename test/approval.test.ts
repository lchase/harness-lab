import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  bashTool,
  createApprovalPolicy,
  readFileTool,
  readSession,
  runLoop,
  SessionLog,
  writeFileTool,
  type ApprovalPrompt,
  type ApprovalPromptChoice,
} from "../src/core/index.js";
import type { AgentEvent } from "../src/core/events.js";
import { FakeProvider } from "../src/provider/fake.js";
import type { AssistantMessage, Message } from "../src/provider/types.js";

function assistant(content: string, toolCalls: AssistantMessage["toolCalls"]): AssistantMessage {
  return { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) };
}

function rootDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "harness-approval-")));
}

test("reads are auto-allowed and writes, prefixes, and denials follow the policy", async () => {
  const root = rootDir();
  const session = SessionLog.create(join(root, "sessions"), { cwd: root, model: "test-model" });
  const asks: string[] = [];
  const script: ApprovalPromptChoice[] = [
    { choice: "allow_once" },
    { choice: "allow_always_tool" },
    { choice: "allow_always_prefix" },
    { choice: "deny", reason: "not this command" },
  ];
  const ask: ApprovalPrompt = async (request) => {
    asks.push(request.call.name);
    const next = script.shift();
    if (!next) throw new Error("unexpected prompt");
    return next;
  };
  const approve = createApprovalPolicy({ ask });
  const events: AgentEvent[] = [];
  const tools = [readFileTool, writeFileTool, bashTool];

  try {
    await writeFileTool.execute({ path: "note.txt", content: "hello\n" }, { cwd: root, timeoutMs: 1000, maxOutputChars: 1000 });

    const messages: Message[] = [{ role: "user", content: "go" }];
    const result = await runLoop({
      provider: new FakeProvider([
        assistant("read", [{ id: "r1", name: "read_file", arguments: { path: "note.txt" } }]),
        assistant("write once", [{ id: "w1", name: "write_file", arguments: { path: "a.txt", content: "A" } }]),
        assistant("write again", [{ id: "w2", name: "write_file", arguments: { path: "b.txt", content: "B" } }]),
        assistant("write third", [{ id: "w3", name: "write_file", arguments: { path: "c.txt", content: "C" } }]),
        assistant("bash prefix", [{ id: "b1", name: "bash", arguments: { command: "printf ONE" } }]),
        assistant("bash same", [{ id: "b2", name: "bash", arguments: { command: "printf TWO" } }]),
        assistant("bash other", [{ id: "b3", name: "bash", arguments: { command: "ls" } }]),
        (request) => {
          const denied = [...request.messages].reverse().find((message) => message.role === "tool");
          assert.ok(denied && denied.role === "tool");
          assert.match(denied.content, /denied/);
          assert.match(denied.content, /not this command/);
          return { role: "assistant", content: "stopped" };
        },
      ]),
      model: "test-model",
      messages,
      tools,
      cwd: root,
      maxTurns: 8,
      approve,
      session,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.stopReason, "completed");
    assert.deepEqual(asks, ["write_file", "write_file", "bash", "bash"]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "A");
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "B");
    assert.equal(readFileSync(join(root, "c.txt"), "utf8"), "C");

    const statuses = events
      .filter((event) => event.type === "tool_call_update")
      .map((event) => (event.type === "tool_call_update" ? `${event.id}:${event.status}` : ""));
    assert.ok(statuses.includes("r1:requested"));
    assert.ok(statuses.includes("r1:running"));
    assert.ok(statuses.includes("r1:completed"));
    assert.equal(statuses.includes("r1:awaiting_approval"), false);
    assert.ok(statuses.includes("w1:awaiting_approval"));
    // w2 is the prompt that stores "always allow write_file". w3 hits that rule.
    assert.ok(statuses.includes("w2:awaiting_approval"));
    assert.equal(statuses.includes("w3:awaiting_approval"), false);
    assert.ok(statuses.includes("b1:awaiting_approval"));
    assert.equal(statuses.includes("b2:awaiting_approval"), false);
    assert.ok(statuses.includes("b3:awaiting_approval"));
    assert.ok(statuses.includes("b3:denied"));
    assert.equal(statuses.includes("b3:running"), false);

    session.close();
    const records = readSession(session.path);
    const approvals = records.filter((record) => record.type === "approval");
    assert.equal(approvals.length, 7);
    assert.deepEqual(
      approvals.map((record) =>
        record.type === "approval" ? `${record.name}:${record.decision}:${record.source}` : "",
      ),
      [
        "read_file:allow_once:auto_read",
        "write_file:allow_once:prompt",
        "write_file:allow_always:prompt",
        "write_file:allow_always:session_rule",
        "bash:allow_always:prompt",
        "bash:allow_always:session_rule",
        "bash:deny:prompt",
      ],
    );
    const denied = approvals.at(-1);
    assert.ok(denied && denied.type === "approval");
    assert.equal(denied.reason, "not this command");
    assert.equal(denied.command, "ls");
    const prefixRule = approvals[4];
    assert.ok(prefixRule && prefixRule.type === "approval");
    assert.equal(prefixRule.scope, "bash_prefix");
    assert.equal(prefixRule.prefix, "printf");
    const prefixHit = approvals[5];
    assert.ok(prefixHit && prefixHit.type === "approval");
    assert.equal(prefixHit.source, "session_rule");
    assert.equal(prefixHit.prefix, "printf");
  } finally {
    session.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("yolo auto-approves without asking", async () => {
  const root = rootDir();
  try {
    let asked = false;
    const approve = createApprovalPolicy({
      yolo: true,
      ask: async () => {
        asked = true;
        return { choice: "deny", reason: "should not ask" };
      },
    });
    const result = await runLoop({
      provider: new FakeProvider([
        assistant("write", [{ id: "w", name: "write_file", arguments: { path: "y.txt", content: "yes" } }]),
        { role: "assistant", content: "done" },
      ]),
      model: "test-model",
      messages: [{ role: "user", content: "go" }],
      tools: [writeFileTool],
      cwd: root,
      approve,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(asked, false);
    assert.equal(readFileSync(join(root, "y.txt"), "utf8"), "yes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
