# Session format (version 1)

Each run writes one append-only JSONL file under the sessions directory (`./sessions` by default, or `--sessions-dir`). The file name is the session id plus `.jsonl`. The harness flushes and `fsync`s every line, so a crash keeps the lines already written.

The phase 1 loop records a session. It does not resume one, and it does not spawn a child. The fields below are part of the format so those later phases can use the same files.

## Records

Every line is one JSON object. `seq` starts at 0 and increases by 1. The first record is the header.

### `session`

```json
{"type":"session","version":1,"seq":0,"id":"ses_2b0c","cwd":"/work","model":"openai/gpt-4o-mini","createdAt":"2026-10-10T21:00:00.000Z"}
```

| Field | Meaning |
|---|---|
| `version` | `1`. Readers should reject any other version. |
| `id` | Session id. Also the file name, without `.jsonl`. |
| `cwd` | Working directory for `bash` on this run. |
| `model` | Model id requested for this run. |
| `createdAt` | ISO-8601 UTC time. |
| `parentSessionId` | Optional. Present when this session was spawned by another session. Omitted for a top-level session. |

A child session points at its parent here:

```json
{"type":"session","version":1,"seq":0,"id":"ses_child","cwd":"/work","model":"openai/gpt-4o-mini","createdAt":"2026-10-10T21:05:00.000Z","parentSessionId":"ses_2b0c"}
```

### `message`

One record per message the model sees: `system`, `user`, `assistant`, or `tool`. Tool results carry `toolCallId` so they stay tied to the assistant `toolCalls` entry with the same id.

```json
{"type":"message","seq":2,"message":{"role":"user","content":"say hello"}}
```

```json
{"type":"message","seq":6,"message":{"role":"tool","content":"hello from harness\n","toolCallId":"call_demo","name":"bash"}}
```

Resume (phase 4) can rebuild the model's history from `message` records alone.

### `event`

One record per loop event. Event types are `assistant_text`, `tool_call`, `tool_result`, `turn_end`, and `stop`. `stop.reason` is `completed`, `max_turns`, or `provider_error`.

```json
{"type":"event","seq":12,"event":{"type":"stop","turn":2,"reason":"completed"}}
```

A UI can replay the run from `event` records. The message list and the event list are both stored because they answer different questions: what the model saw, and what the loop did.

### `child_session`

Written on the **parent** when a child session is spawned. The phase 1 loop never writes this record. `SessionLog.appendChildSession` does, so the shape is fixed and tested.

```json
{"type":"child_session","seq":13,"childSessionId":"ses_child","createdAt":"2026-10-10T21:05:00.000Z","toolCallId":"call_spawn"}
```

| Field | Meaning |
|---|---|
| `childSessionId` | Id of the child session file. |
| `createdAt` | When the link was recorded. |
| `toolCallId` | Optional. The tool call that spawned the child, when the spawn was a tool. |

The link is two-way. The parent has a `child_session` record. The child's header has `parentSessionId`. Phase 5 (subagents) will call `appendChildSession` and open the child with `parentSessionId`. That phase should not need a new record type.

## Writer and reader

`SessionLog.create` in `src/core/session.ts` writes the header. `appendMessage` and `appendEvent` are what `runLoop` calls. `readSession` parses a file back into these records and rejects a missing header, an unknown record type, or a version other than 1.

## Later, on purpose

- Loading a file back into `runLoop` is phase 4. The message records are enough to rebuild history. The loop currently appends the seed messages on every call, which a resume path will have to skip.
- The default sessions directory sits inside the working folder, so `bash` can see the logs. A later phase should keep session files outside the folder the tools can write.
