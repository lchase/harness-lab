import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function listTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listTs(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

test("provider does not import core or the cli", () => {
  for (const file of listTs("src/provider")) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      assert.equal(spec.includes("/core/"), false, `${file} imports ${spec}`);
      assert.equal(spec.includes("/cli/"), false, `${file} imports ${spec}`);
    }
  }
});

test("core does not import the cli and does not print", () => {
  for (const file of listTs("src/core")) {
    const source = readFileSync(file, "utf8");
    for (const spec of importSpecifiers(source)) {
      assert.equal(spec.includes("/cli/"), false, `${file} imports ${spec}`);
    }
    assert.doesNotMatch(source, /\bconsole\.(log|info|debug|error|warn)\b/, file);
  }
});
