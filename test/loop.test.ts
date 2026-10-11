import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { allowAll, bashTool, readSession, runLoop, SessionLog, type Tool } from "../src/core/index.js";
import type { AgentEvent } from "../src/core/events.js";
import { FakeProvider } from "../src/provider/fake.js";
import type { AssistantMessage, Message, Provider, ProviderRequest } from "../src/provider/types.js";

function assistant(content: string, toolCalls?: AssistantMessage["toolCalls"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function collect(events: AgentEvent[]) {
  return (event: AgentEvent): void => {
    events.push(event);
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-loop-"));
}

test("runs several tool turns and then stops when the model is done", async () => {
  const cwd = tempDir();
  try {
    const provider = new FakeProvider([
      assistant("listing", [{ id: "c1", name: "bash", arguments: { command: "printf turn-one" } }]),
      assistant("again", [{ id: "c2", name: "bash", arguments: { command: "printf turn-two" } }]),
      assistant("all done"),
    ]);
    const events: AgentEvent[] = [];
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ];

    const result = await runLoop({
      provider,
      model: "test-model",
      messages,
      tools: [bashTool],
      cwd,
      maxTurns: 6,
      approve: allowAll,
      onEvent: collect(events),
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(result.turns, 3);
    assert.equal(provider.calls.length, 3);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "assistant_text",
        "tool_call",
        "tool_call_update",
        "tool_call_update",
        "tool_call_update",
        "tool_result",
        "turn_end",
        "assistant_text",
        "tool_call",
        "tool_call_update",
        "tool_call_update",
        "tool_call_update",
        "tool_result",
        "turn_end",
        "assistant_text",
        "turn_end",
        "stop",
      ],
    );

    const stop = events.at(-1);
    assert.ok(stop && stop.type === "stop");
    assert.equal(stop.reason, "completed");

    const second = provider.calls[1];
    assert.ok(second);
    const firstResult = second.messages.find((message) => message.role === "tool");
    assert.ok(firstResult && firstResult.role === "tool");
    assert.equal(firstResult.toolCallId, "c1");
    assert.equal(firstResult.content, "turn-one");

    const third = provider.calls[2];
    assert.ok(third);
    const secondResult = [...third.messages].reverse().find((message) => message.role === "tool");
    assert.ok(secondResult && secondResult.role === "tool");
    assert.equal(secondResult.toolCallId, "c2");
    assert.equal(secondResult.content, "turn-two");
    assert.equal(third.tools[0]?.name, "bash");

    const toolEvents = events.filter((event) => event.type === "tool_result");
    assert.equal(toolEvents.length, 2);
    assert.ok(toolEvents.every((event) => event.type === "tool_result" && event.isError === false));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runs every tool call in one reply before the next model call", async () => {
  const cwd = tempDir();
  try {
    const provider = new FakeProvider([
      assistant("both", [
        { id: "a", name: "bash", arguments: { command: "printf AAA" } },
        { id: "b", name: "bash", arguments: { command: "printf BBB" } },
      ]),
      (request) => {
        const outputs = request.messages
          .filter((message) => message.role === "tool")
          .map((message) => (message.role === "tool" ? message.content : ""));
        assert.deepEqual(outputs, ["AAA", "BBB"]);
        return assistant("done");
      },
    ]);

    const result = await runLoop({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "go" }],
      tools: [bashTool],
      cwd,
      maxTurns: 4,
      approve: allowAll,
    });

    assert.equal(result.stopReason, "completed");
    assert.equal(provider.calls.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stops with max_turns and does not call the model again", async () => {
  const cwd = tempDir();
  try {
    const provider = new FakeProvider([
      assistant("", [{ id: "c1", name: "bash", arguments: { command: "printf a" } }]),
      assistant("", [{ id: "c2", name: "bash", arguments: { command: "printf b" } }]),
      assistant("should not run", [{ id: "c3", name: "bash", arguments: { command: "printf c" } }]),
    ]);
    const events: AgentEvent[] = [];

    const result = await runLoop({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "keep going" }],
      tools: [bashTool],
      cwd,
      maxTurns: 2,
      approve: allowAll,
      onEvent: collect(events),
    });

    assert.equal(result.stopReason, "max_turns");
    assert.equal(result.turns, 2);
    assert.equal(provider.calls.length, 2);
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, 2);
    const stop = events.at(-1);
    assert.ok(stop && stop.type === "stop" && stop.reason === "max_turns" && stop.turn === 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a failing command is returned to the model as a tool result", async () => {
  const cwd = tempDir();
  try {
    let sawError = false;
    const provider = new FakeProvider([
      assistant("trying", [{ id: "c1", name: "bash", arguments: { command: "printf nope; exit 3" } }]),
      (request: ProviderRequest): AssistantMessage => {
        const toolMessage = request.messages.find((message) => message.role === "tool");
        assert.ok(toolMessage && toolMessage.role === "tool");
        assert.match(toolMessage.content, /nope/);
        assert.match(toolMessage.content, /exit code 3/);
        sawError = true;
        return assistant("I saw the error");
      },
    ]);
    const events: AgentEvent[] = [];

    const result = await runLoop({
      provider,
      model: "test-model",
      messages: [{ role: "user", content: "break" }],
      tools: [bashTool],
      cwd,
      approve: allowAll,
      onEvent: collect(events),
    });

    assert.equal(sawError, true);
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turns, 2);
    const toolEvent = events.find((event) => event.type === "tool_result");
    assert.ok(toolEvent && toolEvent.type === "tool_result");
    assert.equal(toolEvent.isError, true);
    assert.equal(toolEvent.id, "c1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a tool that throws is fed back as a result and does not escape the loop", async () => {
  const boom: Tool = {
    access: "execute",
    kind: "other",
    schema: {
      name: "boom",
      description: "Always throws.",
      parameters: { type: "object", properties: {} },
    },
    execute() {
      throw new Error("exploded");
    },
  };
  let fedBack = "";
  const provider = new FakeProvider([
    assistant("go", [{ id: "c1", name: "boom", arguments: {} }]),
    (request) => {
      const toolMessage = request.messages.find((message) => message.role === "tool");
      fedBack = toolMessage && toolMessage.role === "tool" ? toolMessage.content : "";
      return assistant("caught it");
    },
  ]);

  const result = await runLoop({
    provider,
    model: "test-model",
    messages: [{ role: "user", content: "go" }],
    tools: [boom],
    cwd: tmpdir(),
    approve: allowAll,
  });

  assert.equal(result.stopReason, "completed");
  assert.match(fedBack, /exploded/);
});

test("an unknown tool and malformed arguments become tool results", async () => {
  const seen: string[] = [];
  const provider = new FakeProvider([
    assistant("bad", [
      { id: "c1", name: "nope", arguments: {} },
      { id: "c2", name: "bash", arguments: {}, argumentsError: "Tool arguments were not valid JSON: bad" },
    ]),
    (request) => {
      for (const message of request.messages) {
        if (message.role === "tool") seen.push(message.content);
      }
      return assistant("ok");
    },
  ]);

  const result = await runLoop({
    provider,
    model: "test-model",
    messages: [{ role: "user", content: "go" }],
    tools: [bashTool],
    cwd: tmpdir(),
    approve: allowAll,
  });

  assert.equal(result.stopReason, "completed");
  assert.match(seen[0] ?? "", /unknown tool "nope"/);
  assert.match(seen[1] ?? "", /not valid JSON/);
});

test("a denied tool call is a tool result", async () => {
  let fedBack = "";
  const provider = new FakeProvider([
    assistant("run", [{ id: "c1", name: "bash", arguments: { command: "printf secret" } }]),
    (request) => {
      const toolMessage = request.messages.find((message) => message.role === "tool");
      fedBack = toolMessage && toolMessage.role === "tool" ? toolMessage.content : "";
      return assistant("stopped");
    },
  ]);

  const result = await runLoop({
    provider,
    model: "test-model",
    messages: [{ role: "user", content: "go" }],
    tools: [bashTool],
    cwd: tmpdir(),
    approve: () => ({
      allowed: false,
      reason: "phase 2 will ask first",
      detail: { decision: "deny", source: "prompt", reason: "phase 2 will ask first" },
    }),
  });

  assert.equal(result.stopReason, "completed");
  assert.match(fedBack, /denied/);
  assert.match(fedBack, /phase 2 will ask first/);
  const decision = await allowAll({ call: { id: "x", name: "bash", arguments: {} }, cwd: tmpdir() });
  assert.equal(decision.allowed, true);
});

test("a provider failure stops the loop as provider_error", async () => {
  const provider: Provider = {
    async complete(): Promise<{ message: AssistantMessage }> {
      throw new Error("network down");
    },
  };
  const events: AgentEvent[] = [];
  const messages: Message[] = [{ role: "user", content: "hi" }];

  const result = await runLoop({
    provider,
    model: "test-model",
    messages,
    tools: [bashTool],
    cwd: tmpdir(),
    onEvent: collect(events),
  });

  assert.equal(result.stopReason, "provider_error");
  assert.equal(result.turns, 0);
  assert.match(result.error ?? "", /network down/);
  assert.equal(messages.length, 1);
  const stop = events.at(-1);
  assert.ok(stop && stop.type === "stop" && stop.reason === "provider_error");
});

test("writes a session log and does not emit a child session", async () => {
  const cwd = tempDir();
  const session = SessionLog.create(join(cwd, "sessions"), { cwd, model: "test-model" });
  try {
    await runLoop({
      provider: new FakeProvider([
        assistant("work", [{ id: "c1", name: "bash", arguments: { command: "printf hi" } }]),
        assistant("finished"),
      ]),
      model: "test-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
      ],
      tools: [bashTool],
      cwd,
      approve: allowAll,
      session,
    });
    session.close();

    const records = readSession(session.path);
    const header = records[0];
    assert.ok(header && header.type === "session");
      assert.equal(header.version, 2);
    assert.equal(header.model, "test-model");
    assert.equal(header.cwd, cwd);
    assert.equal(header.parentSessionId, undefined);
    assert.equal(Object.hasOwn(header, "parentSessionId"), false);
    assert.equal(records.some((record) => record.type === "child_session"), false);

    const messageRecords = records.filter((record) => record.type === "message");
    assert.deepEqual(
      messageRecords.map((record) => (record.type === "message" ? record.message.role : "")),
      ["system", "user", "assistant", "tool", "assistant"],
    );
    assert.deepEqual(
      records.map((record) => record.seq),
      records.map((_, index) => index),
    );
  } finally {
    session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
