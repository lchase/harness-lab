import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS } from "../core/bash.js";
import { DEFAULT_MAX_TURNS } from "../core/loop.js";
import type { CliArgs } from "./args.js";

export const DEFAULT_MODEL = "openai/gpt-4o-mini";

export interface ResolvedConfig {
  provider: "openrouter" | "fake";
  model: string;
  maxTurns: number;
  cwd: string;
  sessionsDir: string;
  timeoutMs: number;
  maxOutputChars: number;
  yolo: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export function resolveConfig(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  cwdDefault: string,
): ResolvedConfig {
  const requested = resolve(cwdDefault, args.cwd ?? ".");
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error(`Working directory does not exist: ${requested}`);
  }
  const cwd = realpathSync(requested);
  const file = loadConfigFile(cwd);

  const provider = args.provider ?? parseProviderName(env.HARNESS_PROVIDER) ?? "openrouter";
  const model = nonempty(args.model) ?? nonempty(env.HARNESS_MODEL) ?? file.model ?? DEFAULT_MODEL;
  const maxTurns =
    args.maxTurns ??
    parsePositiveInt(env.HARNESS_MAX_TURNS, "HARNESS_MAX_TURNS") ??
    file.maxTurns ??
    DEFAULT_MAX_TURNS;

  const sessionsDir = resolve(cwd, args.sessionsDir ?? nonempty(env.HARNESS_SESSIONS_DIR) ?? "sessions");
  const apiKey = nonempty(env.OPENROUTER_API_KEY);
  const baseUrl = nonempty(env.OPENROUTER_BASE_URL);

  return {
    provider,
    model,
    maxTurns,
    cwd,
    sessionsDir,
    timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: args.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    yolo: args.yolo,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

interface FileConfig {
  model?: string;
  maxTurns?: number;
}

function loadConfigFile(cwd: string): FileConfig {
  const path = resolve(cwd, "harness.config.json");
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse ${path}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  const obj = parsed as Record<string, unknown>;
  const model = obj.model;
  const maxTurns = obj.maxTurns;
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    throw new Error(`${path} field "model" must be a non-empty string.`);
  }
  if (
    maxTurns !== undefined &&
    (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)
  ) {
    throw new Error(`${path} field "maxTurns" must be a positive integer.`);
  }

  return {
    ...(typeof model === "string" ? { model: model.trim() } : {}),
    ...(typeof maxTurns === "number" ? { maxTurns } : {}),
  };
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function parseProviderName(raw: string | undefined): "openrouter" | "fake" | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw === "openrouter" || raw === "fake") return raw;
  throw new Error('HARNESS_PROVIDER must be "openrouter" or "fake".');
}
