import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { editFileTool } from "../src/core/edit-file.js";

function setup(): { root: string; ctx: { cwd: string; timeoutMs: number; maxOutputChars: number } } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-edit-")));
  return { root, ctx: { cwd: root, timeoutMs: 1000, maxOutputChars: 4000 } };
}

test("edit_file replaces one exact match", async () => {
  const { root, ctx } = setup();
  try {
    writeFileSync(join(root, "note.txt"), "say hello there\n");
    const result = await editFileTool.execute(
      { path: "note.txt", old_string: "hello", new_string: "hi" },
      ctx,
    );
    assert.equal(result.isError, false);
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "say hi there\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file fails when the snippet is missing", async () => {
  const { root, ctx } = setup();
  try {
    writeFileSync(join(root, "note.txt"), "say hello\n");
    const result = await editFileTool.execute(
      { path: "note.txt", old_string: "goodbye", new_string: "hi" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "edit_no_match");
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "say hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file fails when the snippet matches more than once", async () => {
  const { root, ctx } = setup();
  try {
    writeFileSync(join(root, "note.txt"), "hello hello\n");
    const result = await editFileTool.execute(
      { path: "note.txt", old_string: "hello", new_string: "hi" },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.code, "edit_ambiguous");
    assert.match(result.output, /2 times/);
    assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "hello hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
