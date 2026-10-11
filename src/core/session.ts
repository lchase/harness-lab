import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { Message } from "../provider/types.js";
import type { AgentEvent } from "./events.js";

/**
 * Append-only JSONL session log. One file per session, one record per line,
 * flushed on every write.
 *
 * The header may carry `parentSessionId`. `appendChildSession` writes a
 * `child_session` record that points at a spawned child. The phase 1 loop
 * never spawns a child; the fields are here so subagents can be added
 * without changing the format. Replaying a log back into the loop (resume)
 * is also later. See docs/session-format.md.
 */

export interface SessionHeader {
  type: "session";
  version: 1;
  seq: number;
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  parentSessionId?: string;
}

export interface MessageRecord {
  type: "message";
  seq: number;
  message: Message;
}

export interface EventRecord {
  type: "event";
  seq: number;
  event: AgentEvent;
}

export interface ChildSessionRecord {
  type: "child_session";
  seq: number;
  childSessionId: string;
  createdAt: string;
  toolCallId?: string;
}

export type SessionRecord = SessionHeader | MessageRecord | EventRecord | ChildSessionRecord;

const RECORD_TYPES = new Set(["session", "message", "event", "child_session"]);

export interface CreateSessionOptions {
  cwd: string;
  model: string;
  parentSessionId?: string;
  id?: string;
}

export class SessionLog {
  readonly id: string;
  readonly path: string;
  private fd: number;
  private seq = 0;

  private constructor(path: string, id: string, fd: number) {
    this.path = path;
    this.id = id;
    this.fd = fd;
  }

  static create(dir: string, init: CreateSessionOptions): SessionLog {
    if (init.id !== undefined && !/^[\w.-]+$/.test(init.id)) {
      throw new Error("Session id must contain only letters, numbers, dots, underscores, and dashes.");
    }

    mkdirSync(dir, { recursive: true });
    const id = init.id ?? `ses_${randomUUID()}`;
    const path = join(dir, `${id}.jsonl`);
    const fd = openSync(path, "wx");
    const log = new SessionLog(path, id, fd);

    try {
      log.writeLine({
        type: "session",
        version: 1,
        seq: log.nextSeq(),
        id,
        cwd: init.cwd,
        model: init.model,
        createdAt: new Date().toISOString(),
        ...(init.parentSessionId ? { parentSessionId: init.parentSessionId } : {}),
      });
    } catch (err) {
      log.close();
      throw err;
    }

    return log;
  }

  appendMessage(message: Message): void {
    this.writeLine({ type: "message", seq: this.nextSeq(), message });
  }

  appendEvent(event: AgentEvent): void {
    this.writeLine({ type: "event", seq: this.nextSeq(), event });
  }

  /**
   * Link this session to a child session. Phase 5 will call this when a
   * subagent is spawned. Nothing in the phase 1 loop calls it.
   */
  appendChildSession(link: { childSessionId: string; toolCallId?: string }): void {
    const createdAt = new Date().toISOString();
    if (link.toolCallId) {
      this.writeLine({
        type: "child_session",
        seq: this.nextSeq(),
        childSessionId: link.childSessionId,
        createdAt,
        toolCallId: link.toolCallId,
      });
      return;
    }
    this.writeLine({
      type: "child_session",
      seq: this.nextSeq(),
      childSessionId: link.childSessionId,
      createdAt,
    });
  }

  close(): void {
    if (this.fd === -1) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.fd = -1;
  }

  private nextSeq(): number {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  private writeLine(record: SessionRecord): void {
    if (this.fd === -1) {
      throw new Error(`Session ${this.id} is closed.`);
    }
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(this.fd, buffer, offset);
    }
    fsyncSync(this.fd);
  }
}

export function readSession(path: string): SessionRecord[] {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) {
    throw new Error(`${path}: empty session file`);
  }

  const records: SessionRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`${path}:${i + 1}: invalid JSON`);
    }
    if (!isSessionRecord(parsed)) {
      throw new Error(`${path}:${i + 1}: unknown session record`);
    }
    records.push(parsed);
  }

  const header = records[0];
  if (!header || header.type !== "session") {
    throw new Error(`${path}: first record must be a session header`);
  }
  if (header.version !== 1) {
    throw new Error(`${path}: unsupported session version ${String(header.version)}`);
  }
  return records;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && RECORD_TYPES.has(type);
}
