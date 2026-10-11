import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runBash } from "../src/core/bash.js";
import type { ToolContext } from "../src/core/tools.js";

function ctx(cwd: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    timeoutMs: 5_000,
    maxOutputChars: 4_000,
    ...overrides,
  };
}

test("bash runs in the given working directory", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-bash-")));
  try {
    const result = await runBash({ command: "pwd -P" }, ctx(cwd));
    assert.equal(result.isError, false);
    assert.equal(result.output.trim(), cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a non-zero exit is a tool result", async () => {
  const result = await runBash({ command: "printf 'nope\\n'; exit 3" }, ctx(tmpdir()));
  assert.equal(result.isError, true);
  assert.match(result.output, /nope/);
  assert.match(result.output, /exit code 3/);
});

test("a missing command is a tool result", async () => {
  const result = await runBash({}, ctx(tmpdir()));
  assert.equal(result.isError, true);
  assert.match(result.output, /command/);
});

test("output is truncated", async () => {
  const result = await runBash(
    { command: "head -c 8000 /dev/zero | tr '\\0' 'a'" },
    ctx(tmpdir(), { maxOutputChars: 100 }),
  );
  assert.equal(result.isError, false);
  assert.ok(result.output.startsWith("a".repeat(100)));
  assert.match(result.output, /truncated to 100 characters/);
});

test("a command that exceeds the timeout is a tool result", { timeout: 5_000 }, async () => {
  const result = await runBash({ command: "sleep 2" }, ctx(tmpdir(), { timeoutMs: 300 }));
  assert.equal(result.isError, true);
  assert.match(result.output, /timed out after 300ms/);
});
