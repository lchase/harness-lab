# harness-lab

A coding-agent harness, built from scratch in phases. The model only generates the next message. This program stores the conversation, offers tools, runs the tools, and calls the model again until the model stops asking for them.

Phase 1 is the smallest loop that does that: one provider, one tool (`bash`), a turn cap, a JSONL session log, and a one-shot CLI. Later phases add guardrails, streaming, resume, subagents, and custom bots. The lesson for this phase is [lessons/01-minimal-loop.md](lessons/01-minimal-loop.md).

## How to run

You need Node.js 22 or newer and [pnpm](https://pnpm.io/). There are no runtime dependencies.

```sh
pnpm install
pnpm typecheck
pnpm test
```

Run the loop without an API key. The fake provider follows a built-in script: it runs `printf`, then replies with that output. Your prompt is stored and echoed. It does not choose the command.

```sh
pnpm harness --provider fake "say hello"
```

`pnpm harness -- --provider fake "say hello"` works too. pnpm forwards the `--` separator, and the CLI ignores it.

With an OpenRouter key, the same CLI calls a real model. The model id comes from `--model`, then `HARNESS_MODEL`, then `harness.config.json`, then the default `openai/gpt-4o-mini`. Any id on OpenRouter's model list works, including Grok models such as `x-ai/grok-4` (copy the current id from their models page).

```sh
export OPENROUTER_API_KEY=sk-or-...
pnpm harness "what is in this directory?"

HARNESS_MODEL=x-ai/grok-4 pnpm harness "what is in this directory?"
```

Optional `harness.config.json` in the working directory:

```json
{ "model": "x-ai/grok-4", "maxTurns": 8 }
```

The process exits 0 when the model finishes with no tool calls. It exits 1 when it hits the turn cap, the provider errors, or the prompt is missing.

The live OpenRouter path is implemented and covered by a mocked HTTP test. This repo's checks do not call OpenRouter, so try it with your own key.

## Layer layout

Dependencies point one way: the CLI calls the core, and the core calls a provider. The provider does not import the core. The core does not import the CLI, and it does not print. `test/layers.test.ts` locks that in.

```
src/provider/   neutral messages, OpenRouter, and the scripted fake provider
src/core/       the loop, bash, the approval seam, events, JSONL sessions
src/cli/        the one-shot command: config, system prompt, tool list, printing
test/           the loop against the fake provider
docs/           session file format
lessons/        phase lessons
```

Frontends after this phase, in order: a TUI, a web UI, then a Tauri desktop wrapper. A local server arrives in phase 3. The core stays free of the CLI so those clients can share it.

## How the loop works

`main` builds a system message and a user message and calls `runLoop`. Each turn, the loop sends the whole history plus the tool schemas to the provider. If the assistant message contains tool calls, the loop runs them one at a time, appends each result, and calls the model again. A failing command is appended as a tool result. The model sees it on the next turn.

The loop stops for one of three reasons:

- `completed` — the reply has no tool calls.
- `max_turns` — the turn cap was hit. Tools from the last reply have already run. The model is not called again.
- `provider_error` — the model API threw. Tool failures do not use this reason.

Events (`assistant_text`, `tool_call`, `tool_result`, `turn_end`, `stop`) go to a callback. The CLI prints them. The same callback is how a later TUI will render the run. The core writes the same events, plus every message, to the session log.

```
CLI                         core                          provider
---                         ----                          --------
system + user messages
       |
       +------------------> runLoop
                              |
                              |  history + tool schemas
                              +-------------------------> complete()
                              |                               |
                              | <------ assistant message ---+
                              |
                              |  tool calls?
                              |     approve (allow-all for now)
                              |     bash, cwd = working folder
                              |     append the result
                              |     loop
                              |
                              |  no tool calls, or turn cap
                              |     stop
                              |
       <----- events --------+
       |
       +--> print lines
       +--> sessions/<id>.jsonl
```

## Session log

Each run creates `sessions/<id>.jsonl`. The header holds the id, cwd, model, and created time, and it may hold `parentSessionId`. A `child_session` record type points at a spawned child. Phase 1 never spawns one. The shape is already there so subagents (phase 5) and resume (phase 4) do not need a new format. Details: [docs/session-format.md](docs/session-format.md).

## Planned phases

- [x] **1. Minimal loop.** Provider, bash, stop conditions, session log, CLI. [Lesson](lessons/01-minimal-loop.md).
- [ ] **2. Tools and guardrails.** read, write, edit, and bash; workspace boundary; approval gate.
- [ ] **3. Layers, events, streaming, and a local server.** Token streaming, a TUI, a second provider, a local server.
- [ ] **4. Sessions, AGENTS.md, and compaction.** Resume, project instructions, token accounting, auto-compaction.
- [ ] **5. Subagents, skills, and MCP.** Child agents, skills, hooks, an optional MCP client.
- [ ] **6. Production hardening.** Sandbox, retries, headless runs, tracing, evals.
- [ ] **7. Custom bots.** Persona, memory, tool scopes, triggers, more than one channel.

## Left for later

Approval prompts, read/write/edit, a workspace boundary, token streaming, a REPL, the TUI, the web UI, Tauri, the local server, resume, `AGENTS.md`, compaction, subagents, skills, MCP, retries, and parallel tool calls. The approval function and the child-session record are seams, not those features.
