import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readFileTool, writeFileTool } from "../src/core/index.js";
import { resolveInWorkspace } from "../src/core/workspace.js";

function makeRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "harness-ws-")));
}

test("relative paths inside the workspace resolve", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "sub"));
    const resolved = resolveInWorkspace(root, "sub/note.txt");
    assert.ok(!("isError" in resolved));
    if (!("isError" in resolved)) assert.equal(resolved.path, join(root, "sub/note.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file tools refuse paths that leave the workspace", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    writeFileSync(join(outside, "secret.txt"), "secret");
    const ctx = { cwd: root, timeoutMs: 1000, maxOutputChars: 1000 };
    const cases = ["../secret.txt", outside, join(outside, "secret.txt"), "sub/../../outside.txt"];
    for (const path of cases) {
      const read = await readFileTool.execute({ path }, ctx);
      assert.equal(read.isError, true, path);
      assert.equal(read.code, "path_escape", path);
      const write = await writeFileTool.execute({ path, content: "nope" }, ctx);
      assert.equal(write.isError, true, path);
      assert.equal(write.code, "path_escape", path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("symlinks that point outside the workspace are refused", async () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    writeFileSync(join(outside, "secret.txt"), "secret");
    mkdirSync(join(outside, "dir"));
    writeFileSync(join(outside, "dir", "nested.txt"), "nested");
    symlinkSync(join(outside, "secret.txt"), join(root, "file-link"));
    symlinkSync(join(outside, "dir"), join(root, "dir-link"));

    const ctx = { cwd: root, timeoutMs: 1000, maxOutputChars: 1000 };
    const file = await readFileTool.execute({ path: "file-link" }, ctx);
    assert.equal(file.code, "path_escape");
    const nested = await readFileTool.execute({ path: "dir-link/nested.txt" }, ctx);
    assert.equal(nested.code, "path_escape");
    const write = await writeFileTool.execute({ path: "dir-link/new.txt", content: "x" }, ctx);
    assert.equal(write.code, "path_escape");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink whose target stays inside the workspace is allowed", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "note.txt"), "hello\n");
    symlinkSync(join(root, "note.txt"), join(root, "alias.txt"));
    const result = await readFileTool.execute(
      { path: "alias.txt" },
      { cwd: root, timeoutMs: 1000, maxOutputChars: 1000 },
    );
    assert.equal(result.isError, false);
    assert.match(result.output, /hello/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
