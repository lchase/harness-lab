import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import type { ApprovalPromptRequest } from "../src/core/approval.js";
import { askApproval } from "../src/cli/approve.js";

function request(prefix?: string): ApprovalPromptRequest {
  return {
    call: {
      id: "c1",
      name: prefix ? "bash" : "write_file",
      arguments: prefix ? { command: `${prefix} hi` } : { path: "note.txt" },
    },
    cwd: "/work",
    access: prefix ? "execute" : "write",
    ...(prefix ? { bashPrefix: prefix } : {}),
  };
}

async function answer(lines: string[], prompt: ApprovalPromptRequest) {
  const input = Readable.from(lines.map((line) => `${line}\n`));
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  const choice = await askApproval(prompt, { input, output });
  return { choice, text };
}

test("stdin approval accepts once, always, prefix, and deny", async () => {
  const once = await answer(["y"], request());
  assert.deepEqual(once.choice, { choice: "allow_once" });
  assert.match(once.text, /allow once/);

  const always = await answer(["a"], request());
  assert.deepEqual(always.choice, { choice: "allow_always_tool" });

  const prefix = await answer(["p"], request("printf"));
  assert.deepEqual(prefix.choice, { choice: "allow_always_prefix" });
  assert.match(prefix.text, /printf/);

  const denied = await answer(["n", "too risky"], request());
  assert.deepEqual(denied.choice, { choice: "deny", reason: "too risky" });

  const closed = await answer([], request());
  assert.deepEqual(closed.choice, { choice: "deny", reason: "approval input closed" });
});
