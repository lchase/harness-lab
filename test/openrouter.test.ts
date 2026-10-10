import assert from "node:assert/strict";
import { test } from "node:test";

import { bashTool } from "../src/core/bash.js";
import { OpenRouterProvider } from "../src/provider/openrouter.js";
import type { ProviderRequest } from "../src/provider/types.js";

const request: ProviderRequest = {
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_0", name: "bash", arguments: { command: "pwd" } }],
    },
    { role: "tool", content: "/tmp", toolCallId: "call_0", name: "bash" },
  ],
  tools: [bashTool.schema],
};

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    return handler(String(input), init);
  }) as typeof fetch;
}

test("translates chat messages and tool calls to the OpenAI shape", async () => {
  let seenUrl = "";
  let seenAuth = "";
  let seenBody: Record<string, unknown> = {};

  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    fetch: mockFetch((url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "hi",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "bash", arguments: '{"command":"ls"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  });

  const response = await provider.complete(request);
  assert.equal(seenUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(seenAuth, "Bearer test-key");
  assert.equal(seenBody.model, "openai/gpt-4o-mini");

  const tools = seenBody.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools[0]?.type, "function");
  assert.equal(tools[0]?.function.name, "bash");

  const messages = seenBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[2]?.content, null);
  const wireCalls = messages[2]?.tool_calls as Array<{ function: { arguments: string } }>;
  assert.equal(wireCalls[0]?.function.arguments, '{"command":"pwd"}');
  assert.equal(messages[3]?.role, "tool");
  assert.equal(messages[3]?.tool_call_id, "call_0");
  assert.equal(messages[3]?.content, "/tmp");

  assert.equal(response.message.content, "hi");
  assert.equal(response.message.toolCalls?.[0]?.id, "call_1");
  assert.equal(response.message.toolCalls?.[0]?.arguments.command, "ls");
});

test("malformed tool arguments are marked and not thrown", async () => {
  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    fetch: mockFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: "call_x", function: { name: "bash", arguments: "not-json" } }],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    ),
  });

  const response = await provider.complete({ ...request, messages: [{ role: "user", content: "hi" }] });
  const call = response.message.toolCalls?.[0];
  assert.ok(call);
  assert.match(call.argumentsError ?? "", /not valid JSON/);
  assert.deepEqual(call.arguments, {});
});

test("a non-200 response throws", async () => {
  const provider = new OpenRouterProvider({
    apiKey: "test-key",
    baseUrl: "http://example.test/v1/",
    fetch: mockFetch((url) => {
      assert.equal(url, "http://example.test/v1/chat/completions");
      return new Response("nope", { status: 401 });
    }),
  });

  await assert.rejects(() => provider.complete(request), /401/);
});

test("an empty API key is rejected", () => {
  assert.throws(() => new OpenRouterProvider({ apiKey: "  " }), /OPENROUTER_API_KEY/);
});
