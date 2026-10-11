# Phase 1: The minimal loop

This lesson walks through the first working slice of harness-lab. You send a conversation to a model, run the tool calls it asks for, and repeat until it stops.

You should already be comfortable with TypeScript, JSON, and the shell. You do not need to have built an agent before.

## Learning goals

After this lesson you should be able to:

- Point at `src/provider`, `src/core`, and `src/cli` and say what each one owns.
- Trace one prompt from `main` through `runLoop` and back out as console lines and a JSONL file.
- Name the three stop reasons and say which one a failed shell command uses.
- Explain why a failed command is appended to the conversation.

## Concepts

### The harness, the model, and the app

Three programs are easy to tangle because people call all of them "the agent."

The **model** is the API that completes a chat. You send messages. It sends one assistant message back. It does not remember the previous HTTP call. It does not run `bash`. OpenRouter, and the fake provider in tests, are both models in this sense. They live in `src/provider`.

The **harness** is the program around the model. It keeps the message list, tells the model which tools exist, runs the tools the model asks for, and calls the model again. That code is `runLoop` in `src/core`. It emits events. It prints nothing.

The **app** is what a person actually starts. Phase 1's app is the CLI in `src/cli`. It chooses the model, the system prompt, and the tool list, then prints events as text. A TUI, a web UI, and a Tauri window will be other apps on the same core. A local server arrives in phase 3. The core does not import the CLI, so those later apps can share the loop. `test/layers.test.ts` fails the build if that import appears.

```
cli  →  core  →  provider
```

### The tool-use loop

The model sees a list of messages and a list of tool schemas. A schema is a name, a description, and a JSON Schema for the arguments. The model replies with text, with tool calls, or with both.

A tool call is a request: an id, a tool name, and arguments. The harness runs that tool on the machine, then appends a tool message whose `toolCallId` matches the call. The next model call receives the whole list, including that result.

One turn is one model call plus the tool calls in that reply. Tool calls in a single reply run one after another. Parallel calls are a later phase.

Phase 1 has one tool, `bash`. Its working directory is the folder you passed as `cwd`, which is the process's current directory unless you pass `--cwd`. Output is cut off at 16,000 characters. The process is killed after 30 seconds. Both limits are arguments on the tool context, so a caller can tighten them.

### Stop conditions

`runLoop` stops for three reasons. The stop event carries the reason.

| Reason | When |
|---|---|
| `completed` | The assistant message has no tool calls. Text in that message is the answer. |
| `max_turns` | The loop has made `maxTurns` model calls (default 8) and the last reply still asked for tools. Those tools have already run. The model is not called again, so it never sees the last results. |
| `provider_error` | The provider threw: network failure, HTTP error, unreadable body. The loop catches it, emits `stop`, and returns. |

A reply that contains text and tool calls is not finished. The text is emitted, the tools run, and the loop continues. A reply on the last allowed turn that has no tool calls is `completed`, even when the turn number equals the cap.

### Why tool errors go back to the model

A command can fail because the path is missing, the exit code is non-zero, the process times out, or the executor throws. If the harness threw that error out of the loop, the model would never see it and could not try something else.

`runBash` returns `{ output, isError: true }` for a bad command, a timeout, and a non-zero exit. `executeTool` catches a thrown executor and returns the same shape. `runLoop` appends the output as a normal tool message and emits `tool_result` with `isError: true`. The next `complete` call includes that message.

`provider_error` is the other kind of failure. The model API itself failed, so there is no assistant message to continue from.

There is a related seam for phase 2. Before a tool runs, `runToolCall` asks an approver. Phase 1 passes `allowAll`, which always allows. A denial is also a tool result (`Error: tool call denied. …`), so the model can read it. Phase 2 replaces the approver. The loop already knows what to do with a "no."

## Diagram

```mermaid
flowchart TD
  main["CLI: system + user messages"] --> loop["runLoop"]
  loop --> call["provider.complete"]
  call --> decision{"tool calls in the reply?"}
  decision -->|none| done["stop: completed"]
  decision -->|yes| gate["approve — allowAll in phase 1"]
  gate -->|allowed| bash["runBash in cwd"]
  gate -->|denied| result["append tool message"]
  bash --> result
  result --> cap{"turn cap reached?"}
  cap -->|no| loop
  cap -->|yes| maxed["stop: max_turns"]
  call -->|throws| failed["stop: provider_error"]
  loop --> out["onEvent and the JSONL log"]
```

## Walkthrough

Read the files in this order. Each one is short. The `index.ts` files only re-export; skip them until an import sends you there.

1. `src/provider/types.ts`
2. `src/provider/fake.ts`
3. `src/provider/openrouter.ts`
4. `src/core/events.ts`
5. `src/core/approval.ts`
6. `src/core/tools.ts`
7. `src/core/bash.ts`
8. `src/core/session.ts`
9. `src/core/loop.ts`
10. `src/cli/agent.ts`
11. `src/cli/demo.ts`
12. `src/cli/print.ts`
13. `src/cli/config.ts`
14. `src/cli/args.ts`
15. `src/cli/main.ts`

### Neutral messages

`src/provider/types.ts` is the vocabulary every provider shares. A `Message` is a system, user, assistant, or tool message. An assistant message may carry `toolCalls`. A tool message carries `toolCallId` and `name`. `ToolSchema` is what the model is shown. `Provider` has one method, `complete`, which takes a `ProviderRequest` and returns the assistant message. Streaming is a later phase; `complete` returns the finished message.

The core imports these types. It never builds an OpenAI HTTP body itself.

### A provider you can script

`FakeProvider` in `src/provider/fake.ts` implements `Provider` with a list of steps. A step is either an assistant message or a function of the request. Tests pass a script: tool call, tool call, final text. `calls` stores a clone of each request, so a test can assert what the model was shown after the tools ran.

When the script runs out, the next call returns a plain assistant message. A short script cannot spin the loop forever.

The CLI's demo script is not this class. It is `createDemoProvider` in `src/cli/demo.ts`, which builds a `FakeProvider` with two steps: run `printf 'hello from harness\n'`, then answer with that output and the user's prompt.

### OpenRouter

`OpenRouterProvider.complete` in `src/provider/openrouter.ts` POSTs to `{baseUrl}/chat/completions`. The default base URL is `https://openrouter.ai/api/v1`. The key is the `Authorization: Bearer` header, from `OPENROUTER_API_KEY`.

`toWireMessages` turns our messages into OpenAI chat messages. Assistant text becomes `content`, or `null` when the text is empty. Tool calls become `tool_calls` with `function.arguments` as a JSON string. Tool messages become `{ role: "tool", tool_call_id, content }`.

`fromWireMessage` reads `choices[0].message` and parses those tool calls back. Invalid argument JSON sets `argumentsError` on the `ToolCall` and leaves `arguments` as `{}`. The loop will turn that into a tool result. It does not throw.

A non-200 response throws. `runLoop` catches that and stops with `provider_error`.

The HTTP JSON also includes a `usage` object with token counts. `fromWireMessage` ignores it. Exercise 4 puts it back.

### Events

`src/core/events.ts` defines `AgentEvent`. Five types: `assistant_text`, `tool_call`, `tool_result`, `turn_end`, `stop`. `StopReason` is `completed`, `max_turns`, or `provider_error`. `EventHandler` is the callback the CLI passes as `onEvent`.

`printEvent` in `src/cli/print.ts` is a switch on `event.type`. The default branch is typed as `never`, so adding an event type without updating the CLI is a type error. That is the point of emitting events from the core: every frontend matches on the same set.

### The approval seam

`src/core/approval.ts` exports `Approver`, `ApprovalDecision`, and `allowAll`. Read the comment at the top of the file. `allowAll` returns `{ allowed: true }`. The loop's default argument is `approve = allowAll`. A later phase passes a different function into `runLoop`. You can see the deny path today in `runToolCall`, and `test/loop.test.ts` covers it.

### Tools

`src/core/tools.ts` defines `Tool`: a `schema` plus `execute(args, ctx)`. `executeTool` finds the tool by `schema.name`. An unknown name becomes an error result. A thrown `execute` becomes an error result. Either way the function returns. It does not throw.

`bashTool` and `runBash` are in `src/core/bash.ts`. `runBash` checks that `command` is a non-empty string, then spawns `bash -lc` with `cwd` set to `ctx.cwd`. The child is its own process group so a timeout can kill the pipeline, not only the shell. Stdout and stderr share one buffer. Past `maxOutputChars`, the process is killed and a truncation note is appended. Past `timeoutMs`, the result says the command timed out. A non-zero exit appends `[exit code N]`. All of those resolve the promise. None of them reject it.

The app decides the tool list. `createAgentTools` in `src/cli/agent.ts` returns `[bashTool]`. The loop does not mention bash by name.

### The session log

`SessionLog` in `src/core/session.ts` appends one JSON object per line and `fsync`s it. `create` writes the header: `version`, `id`, `cwd`, `model`, `createdAt`, and `parentSessionId` when you pass one. `appendMessage` and `appendEvent` are what the loop calls. `appendChildSession` writes a `child_session` record that points at a child id. Search the repo: `runLoop` does not call it. Phase 5 will.

`readSession` parses the file and rejects a missing header, an unknown record type, or a version other than 1. The field list, and how parent and child point at each other, is [docs/session-format.md](../docs/session-format.md).

Message records are the transcript the model saw. Event records are what a UI would replay. Both are stored.

### The loop

`runLoop` in `src/core/loop.ts` is the harness for a single prompt.

It checks `maxTurns`, `timeoutMs`, and `maxOutputChars`. It defines `emit`, which appends the event to the session and then calls `onEvent`. It appends the seed messages (the system and user messages the CLI already built) to the session. Resume, in phase 4, will have to skip that, because the messages will already be in the file.

The turn loop is `for (let turn = 1; turn <= maxTurns; turn++)`:

1. `provider.complete({ model, messages, tools: schemas })`. On throw, emit `stop` with `provider_error` and return.
2. Append the assistant message. If `content` is non-empty, emit `assistant_text`.
3. If there are no tool calls, emit `turn_end` and `stop` with `completed`, and return.
4. For each call, emit `tool_call`, run `runToolCall`, append a tool message, emit `tool_result`.
5. Emit `turn_end` with `hadToolCalls: true`, then go to the next turn.

If the `for` loop ends, every allowed turn asked for tools. Emit `stop` with `max_turns`.

`runToolCall` is the function under the loop. If `argumentsError` is set, it returns an error result and does not run the tool. Otherwise it `await`s `approve`. A denial becomes `Error: tool call denied. …`. An approval calls `executeTool`.

`messages` is mutated. The returned `LoopResult` has `stopReason`, `turns` (model calls that returned), and the same array.

### The app

`systemPrompt` and `createAgentTools` in `src/cli/agent.ts` are the agent definition: the text that tells the model who it is, and the tools it may call. The core receives both as arguments. It does not contain the prompt string.

`resolveConfig` in `src/cli/config.ts` merges flags, environment, `harness.config.json`, and defaults. `parseArgs` in `src/cli/args.ts` is the flag parser.

`main` in `src/cli/main.ts` parses argv, builds the provider (`createDemoProvider` or `OpenRouterProvider`), opens a `SessionLog`, and calls `runLoop` with `onEvent: printEvent`. The session is closed in a `finally`. The process exits 0 only when `stopReason` is `completed`.

### One prompt, end to end

`pnpm harness --provider fake "say hello"` does this:

1. `main` writes a system message and `{ role: "user", content: "say hello" }`.
2. `runLoop` logs those two messages, then calls the fake provider.
3. Step 1 of the demo returns an assistant message with one `bash` call. The loop emits the text and the tool call, runs `printf` in the working directory, and appends the tool result `hello from harness`.
4. Step 2 of the demo reads that tool message and returns text starting with `Done.` No tool calls, so the loop stops with `completed`.
5. `printEvent` has printed each event. The JSONL file has the header, every message, and every event.

The fake model did not read your prompt in order to choose an action. The second step pastes the prompt into its reply. A real OpenRouter model chooses the command.

## Run it

Install and check the project:

```sh
pnpm install
pnpm typecheck
pnpm test
```

Fake provider, no API key:

```sh
pnpm harness --provider fake "say hello"
```

You should see lines in this shape. The session id will differ.

```
provider=fake model=openai/gpt-4o-mini
session=/workspace/sessions/ses_….jsonl
[turn 1] assistant: I'll run a command in the working directory.
[turn 1] tool_call bash call_demo {"command":"printf 'hello from harness\\n'"}
[turn 1] tool_result bash call_demo ok
hello from harness
[turn 1] turn_end tools=yes
[turn 2] assistant: Done. You asked: say hello
hello from harness
[turn 2] turn_end tools=no
[stop] completed turn=2
```

Open the path on the `session=` line. The first line is the header. Later lines alternate messages and events. There is no `parentSessionId` and no `child_session` record.

OpenRouter, with your own key:

```sh
export OPENROUTER_API_KEY=sk-or-...
pnpm harness "list the files in this directory and summarize them"
```

To try another model, including Grok, set the id OpenRouter publishes:

```sh
HARNESS_MODEL=x-ai/grok-4 pnpm harness "list the files in this directory and summarize them"
```

If the id has moved, copy the current one from OpenRouter's models page. A missing key fails in `main` before any HTTP call, with `Set OPENROUTER_API_KEY, or run with --provider fake.` The tests stub `fetch` in `test/openrouter.test.ts`. They do not hit the network.

## Exercises

Do these in a scratch branch or revert them before you commit. `pnpm test` should pass again when you are done, except where an exercise tells you to add a test.

### 1. Hit the turn cap

Run:

```sh
pnpm harness --provider fake --max-turns 1 "say hello"
```

The tool still runs, because the cap is checked after the tools of that turn. The stop line is `max_turns`, the `Done.` reply is absent, and the process exits 1.

In `runLoop`, find `for (let turn = 1; turn <= maxTurns; turn++)` and `DEFAULT_MAX_TURNS`. Describe, in a sentence, why a model that answers with plain text on turn 8 stops with `completed` rather than `max_turns`.

### 2. Feed an error back

In `createDemoProvider` (`src/cli/demo.ts`), change the bash command to `ls /no/such/harness-path`. Run the fake CLI again.

You should see `tool_result` marked `error`, with the shell's message and an exit code, and the following assistant text should contain that same output. The process still exits 0, because the script's second step does not ask for another tool.

That path is `runBash` (non-zero exit) → `runToolCall` → a tool message on the next `complete` call. The test named "a failing command is returned to the model as a tool result" in `test/loop.test.ts` locks the same behavior. Revert `demo.ts` when you are finished.

### 3. Add a `read_file` tool

Add `src/core/read-file.ts` that exports a `Tool`, following `bashTool`.

- Schema name `read_file`, one string argument `path`.
- In `execute`, if `path` is not a non-empty string, return an error result. Do not throw.
- Resolve the path against `ctx.cwd` and read the file as UTF-8. On failure, return an error result whose `output` says what went wrong.
- If the file is longer than `ctx.maxOutputChars`, keep the head and append a short truncation note, the way `runBash` does.

Register it in `createAgentTools` so the schema is sent on every model call. The fake demo will not call it until you change the script or, better, add a test next to the loop tests: a `FakeProvider` step that calls `read_file`, then a second step that asserts the tool message contains a fixture file you wrote in a temp directory.

`path.resolve(ctx.cwd, userPath)` still accepts `../`. Leave that alone. Phase 2 is the workspace boundary, and this exercise is why it exists.

### 4. Log token usage

OpenRouter's JSON includes `usage` with `prompt_tokens`, `completion_tokens`, and `total_tokens`. `fromWireMessage` drops everything outside `choices[0].message`. The mock response in `test/openrouter.test.ts` already sends a `usage` object, and the test never reads it.

Add an optional `usage` field on `ProviderResponse`. Copy it out in `OpenRouterProvider.complete`. Assert the numbers in that test. Print one console line from the CLI when the field is present. The fake provider can leave it undefined.

### 5. Read the session file

Run the fake CLI once. Pretty-print the JSONL (each line is one object).

- Find the header and confirm `version`, `id`, `cwd`, `model`, and `createdAt`.
- Find the tool message and the `tool_result` event that share `call_demo`. Why are both stored?
- Confirm `parentSessionId` is absent.

Then open `appendChildSession` and [docs/session-format.md](../docs/session-format.md). Write down which record the parent file gains when phase 5 spawns a child, and which field on the child header points back.

## What's next

Phase 2 is tools and guardrails. You will add read, write, and edit next to bash, refuse paths that escape the working folder, and replace `allowAll` with a real check. `runToolCall` already turns a denial into a tool result. Phase 2 decides when to deny.

Streaming, the TUI, and the local server are phase 3. Resume and `AGENTS.md` are phase 4. `appendChildSession` is unused until phase 5.

## Further watching

- Prompt Engineering, [What is an Agent Harness?](https://youtu.be/nWzXyjXCoCE) — the vocabulary for the loop, tools, and the program around the model.
- Owain Lewis, [Build Your Own Coding Agent (From Scratch)](https://www.youtube.com/watch?v=kU8Tg1_PYJE) — a from-scratch build of this same loop, with an event callback in the role `onEvent` plays here.
- Decoding AI, [lesson 1](https://youtu.be/sJpop1juVBQ) — the wider system this phase is the first slice of.
