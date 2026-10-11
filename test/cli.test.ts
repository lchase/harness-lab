import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { readSession } from "../src/core/session.js";
import { main } from "../src/cli/main.js";

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const code = await run();
    return { code, stdout: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("cli", { concurrency: false }, () => {
  test("fake provider runs the loop and writes a session without an API key", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-cli-")));
    const sessions = join(cwd, "sessions");
    try {
      const { code, stdout } = await capture(() =>
        main(
          ["--", "--provider", "fake", "--yolo", "--cwd", cwd, "--sessions-dir", sessions, "say hello"],
          { env: {} },
        ),
      );

      assert.equal(code, 0);
      assert.match(stdout, /provider=fake/);
      assert.match(stdout, /tool_call bash call_demo/);
      assert.match(stdout, /hello from harness/);
      assert.match(stdout, /Done\. You asked: say hello/);
      assert.match(stdout, /\[stop\] completed turn=2/);

      const sessionPath = stdout.match(/session=(.+)/)?.[1];
      assert.ok(sessionPath);
      const records = readSession(sessionPath);
      const header = records[0];
      assert.ok(header && header.type === "session");
      assert.equal(header.cwd, cwd);
      assert.equal(header.parentSessionId, undefined);
      assert.equal(records.some((record) => record.type === "child_session"), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("max-turns 1 stops the demo after the tool call", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-cli-")));
    try {
      const { code, stdout } = await capture(() =>
        main(["--provider", "fake", "--yolo", "--max-turns", "1", "--cwd", cwd, "--sessions-dir", join(cwd, "sessions"), "hello"], {
          env: {},
        }),
      );
      assert.equal(code, 1);
      assert.match(stdout, /hello from harness/);
      assert.match(stdout, /\[stop\] max_turns turn=1/);
      assert.doesNotMatch(stdout, /Done\./);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("openrouter without a key fails before any network call", async () => {
    await assert.rejects(
      () => main(["--provider", "openrouter", "hi"], { env: {} }),
      /OPENROUTER_API_KEY/,
    );
  });

  test("help exits 0 and a missing prompt exits 1", async () => {
    const help = await capture(() => main(["--help"], { env: {} }));
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage:/);

    const missing = await capture(() => main([], { env: {} }));
    assert.equal(missing.code, 1);
  });
});
