# Session format (version 2)

Each run writes one append-only JSONL file under the sessions directory (`./sessions` by default, or `--sessions-dir`). The file name is the session id plus `.jsonl`. The harness flushes and `fsync`s every line, so a crash keeps the lines already written.

New files are version 2. `readSession` still accepts version 1, which is the phase 1 file: the same records except `approval`. The loop records a session. It does not resume one, and it does not spawn a child. The parent and child fields are part of the format so those later phases can use the same files.

## Records

Every line is one JSON object. `seq` starts at 0 and increases by 1. The first record is the header.

### `session`

```json
{"type":"session","version":2,"seq":0,"id":"ses_2b0c","cwd":"/work","model":"openai/gpt-4o-mini","createdAt":"2026-10-10T21:00:00.000Z"}
```

| Field | Meaning |
|---|---|
| `version` | `2` for a file written now. `1` is a phase 1 file and still parses. Any other version is rejected. |
| `id` | Session id. Also the file name, without `.jsonl`. |
| `cwd` | Working directory for tools on this run. File tools refuse paths outside it. `bash` uses it as its cwd and is not sandboxed. |
| `model` | Model id requested for this run. |
| `createdAt` | ISO-8601 UTC time. |
| `parentSessionId` | Optional. Present when this session was spawned by another session. Omitted for a top-level session. |

A child session points at its parent here:

```json
{"type":"session","version":2,"seq":0,"id":"ses_child","cwd":"/work","model":"openai/gpt-4o-mini","createdAt":"2026-10-10T21:05:00.000Z","parentSessionId":"ses_2b0c"}
```

### `message`

One record per message the model sees: `system`, `user`, `assistant`, or `tool`. Tool results carry `toolCallId` so they stay tied to the assistant `toolCalls` entry with the same id.

```json
{"type":"message","seq":2,"message":{"role":"user","content":"say hello"}}
```

```json
{"type":"message","seq":6,"message":{"role":"tool","content":"hello from harness\n","toolCallId":"call_demo","name":"bash"}}
```

A denial is a normal tool message. The content starts with `Error (denied):`.

Resume (phase 4) can rebuild the model's history from `message` records alone.

### `event`

One record per loop event. Event types are `assistant_text`, `tool_call`, `tool_call_update`, `tool_result`, `turn_end`, and `stop`. `stop.reason` is `completed`, `max_turns`, or `provider_error`.

`tool_call_update` is one status change for a tool call: `requested`, `awaiting_approval`, `running`, `completed`, `failed`, or `denied`. It carries `id`, `name`, `title`, `kind`, and `status`, plus `rawInput` or `rawOutput` when that step has them. The names sit close to the Agent Client Protocol's tool-call vocabulary. ACP is not a dependency.

```json
{"type":"event","seq":8,"event":{"type":"tool_call_update","turn":1,"id":"call_demo","name":"bash","title":"bash printf 'hello from harness\\n'","kind":"execute","status":"completed","rawOutput":"hello from harness\n"}}
```

```json
{"type":"event","seq":12,"event":{"type":"stop","turn":2,"reason":"completed"}}
```

A UI can replay the run from `event` records. The message list and the event list are both stored because they answer different questions: what the model saw, and what the loop did.

### `approval`

Written when a known tool with valid arguments is checked by the approver. One record per such call, including auto-approved reads and `--yolo`. Unknown tools and malformed arguments do not get a record. They become a `failed` status and a tool message instead.

```json
{"type":"approval","seq":7,"toolCallId":"call_demo","name":"bash","decision":"allow_always","source":"prompt","createdAt":"2026-10-10T21:01:00.000Z","scope":"bash_prefix","prefix":"printf","command":"printf 'hello from harness\\n'"}
```

| Field | Meaning |
|---|---|
| `toolCallId` | The tool call this decision belongs to. |
| `name` | Tool name. |
| `decision` | `allow_once`, `allow_always`, or `deny`. |
| `source` | `auto_read`, `session_rule`, `prompt`, `yolo`, or `allow_all`. |
| `createdAt` | When the decision was recorded. |
| `scope` | Optional. `read`, `tool`, or `bash_prefix`. |
| `prefix` | Optional. The bash token a prefix rule stored or matched. |
| `reason` | Optional. Present on a denial. |
| `path` | Optional. The `path` argument, when the call had one. |
| `command` | Optional. The `command` argument, when the call had one. |

`session_rule` means an earlier `allow_always` in this same process covered the call, either by tool name or by bash prefix. The memory is not loaded from the file. Resume will not reconstruct it until a later phase does that on purpose.

### `child_session`

Written on the **parent** when a child session is spawned. The loop never writes this record. `SessionLog.appendChildSession` does, so the shape is fixed and tested.

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

`SessionLog.create` in `src/core/session.ts` writes the version 2 header. `appendMessage` and `appendEvent` are what `runLoop` calls. `appendApproval` writes the decision record. `readSession` parses a file back into these records and rejects a missing header, an unknown record type, or a version other than 1 or 2.

## Later, on purpose

- Loading a file back into `runLoop` is phase 4. The message records are enough to rebuild history. The loop currently appends the seed messages on every call, which a resume path will have to skip. Approval memory is not part of that history.
- The default sessions directory sits inside the working folder, so `bash` can see the logs. A later phase should keep session files outside the folder the tools can write.
- Sandboxing `bash` is phase 6. The session format does not try to record what a shell did outside the workspace.
