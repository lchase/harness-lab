import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { globTool, matchGlob, readFileTool, ToolRegistry, writeFileTool } from "../src/core/index.js";

function setup(): { root: string; ctx: { cwd: string; timeoutMs: number; maxOutputChars: number } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-files-")));
  return { root, ctx: { cwd: root, timeoutMs: 1000, maxOutputChars: 200 } };
}

test("read_file returns a line range and caps output", async () => {
  const { root, ctx } = setup();
  try {
    writeFileSync(join(root, "note.txt"), "one\ntwo\nthree\nfour\n");
    const range = await readFileTool.execute({ path: "note.txt", start_line: 2, end_line: 3 }, ctx);
    assert.equal(range.isError, false);
    assert.match(range.output, /2\|two/);
    assert.match(range.output, /3\|three/);
    assert.doesNotMatch(range.output, /one/);
    assert.doesNotMatch(range.output, /four/);

    const capped = await readFileTool.execute(
      { path: "note.txt" },
      { ...ctx, maxOutputChars: 8 },
    );
    assert.match(capped.output, /truncated to 8 characters/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write_file creates parent directories", async () => {
  const { root, ctx } = setup();
  try {
    const result = await writeFileTool.execute({ path: "sub/dir/note.txt", content: "hi" }, ctx);
    assert.equal(result.isError, false);
    const read = await readFileTool.execute({ path: "sub/dir/note.txt" }, ctx);
    assert.match(read.output, /hi/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob lists matches inside the workspace", async () => {
  const { root, ctx } = setup();
  try {
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, "b.txt"), "");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "c.ts"), "");
    const top = await globTool.execute({ pattern: "*.ts" }, ctx);
    assert.equal(top.output, "a.ts");
    const nested = await globTool.execute({ pattern: "src/**/*.ts" }, ctx);
    assert.equal(nested.output, "src/c.ts");
    assert.equal(matchGlob("*.txt", "b.txt"), true);
    assert.equal(matchGlob("*.txt", "src/b.txt"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry rejects a duplicate name and lists tools in order", () => {
  const registry = new ToolRegistry();
  registry.register(readFileTool).register(globTool);
  assert.deepEqual(
    registry.list().map((tool) => tool.schema.name),
    ["read_file", "glob"],
  );
  assert.throws(() => registry.register(readFileTool), /already registered/);
});
