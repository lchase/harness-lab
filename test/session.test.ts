import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSession, SessionLog } from "../src/core/session.js";

test("session header carries parentSessionId and a child_session record links the child", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-session-"));
  try {
    const log = SessionLog.create(dir, {
      id: "ses_child",
      cwd: "/work",
      model: "openai/gpt-4o-mini",
      parentSessionId: "ses_parent",
    });
    log.appendMessage({ role: "user", content: "hi" });
    log.appendEvent({ type: "stop", turn: 1, reason: "completed" });
    log.appendChildSession({ childSessionId: "ses_grandchild", toolCallId: "call_spawn" });
    log.close();

    const records = readSession(log.path);
    assert.equal(records.length, 4);

    const header = records[0];
    assert.ok(header && header.type === "session");
    assert.equal(header.version, 2);
    assert.equal(header.seq, 0);
    assert.equal(header.id, "ses_child");
    assert.equal(header.cwd, "/work");
    assert.equal(header.model, "openai/gpt-4o-mini");
    assert.equal(header.parentSessionId, "ses_parent");
    assert.match(header.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const message = records[1];
    assert.ok(message && message.type === "message" && message.seq === 1);
    assert.deepEqual(message.message, { role: "user", content: "hi" });

    const event = records[2];
    assert.ok(event && event.type === "event" && event.seq === 2);
    assert.deepEqual(event.event, { type: "stop", turn: 1, reason: "completed" });

    const child = records[3];
    assert.ok(child && child.type === "child_session" && child.seq === 3);
    assert.equal(child.childSessionId, "ses_grandchild");
    assert.equal(child.toolCallId, "call_spawn");
    assert.match(child.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const top = SessionLog.create(dir, { id: "ses_top", cwd: "/work", model: "m" });
    top.close();
    const topHeader = readSession(top.path)[0];
    assert.ok(topHeader && topHeader.type === "session");
    assert.equal(Object.hasOwn(topHeader, "parentSessionId"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSession rejects a file that does not start with a header", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-session-"));
  try {
    const path = join(dir, "broken.jsonl");
    writeFileSync(path, '{"type":"message","seq":0,"message":{"role":"user","content":"x"}}\n');
    assert.throws(() => readSession(path), /session header/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
