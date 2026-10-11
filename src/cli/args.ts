export interface CliArgs {
  help: boolean;
  prompt?: string;
  provider?: "openrouter" | "fake";
  model?: string;
  maxTurns?: number;
  cwd?: string;
  sessionsDir?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  yolo: boolean;
}

export const HELP = `harness — one-shot coding agent loop

Usage:
  harness "prompt"
  harness --provider fake "prompt"

Options:
  --provider openrouter|fake   Model provider (default: openrouter, or HARNESS_PROVIDER)
  --model <id>                 OpenRouter model id (default: openai/gpt-4o-mini, or HARNESS_MODEL)
  --max-turns <n>              Cap on model calls (default: 8, or HARNESS_MAX_TURNS)
  --cwd <dir>                  Working directory for bash and the session record
  --sessions-dir <dir>         Directory for JSONL session logs (default: ./sessions)
  --timeout <ms>               Bash timeout in milliseconds (default: 30000)
  --max-output <chars>         Bash output cap (default: 16000)
  --yolo                       Auto-approve every tool call. Prints a warning.
  -h, --help

Environment:
  OPENROUTER_API_KEY           Required for --provider openrouter
  OPENROUTER_BASE_URL          Override the API origin (include /api/v1)
  HARNESS_MODEL                Model id
  HARNESS_PROVIDER             openrouter or fake
  HARNESS_MAX_TURNS            Turn cap
  HARNESS_SESSIONS_DIR         Session directory

Optional config file: harness.config.json in the working directory
  { "model": "x-ai/grok-4", "maxTurns": 8 }

Precedence: flags, then environment, then harness.config.json, then defaults.
The fake provider runs a built-in script and does not call a model.
`;

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { help: false, yolo: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--") {
      // pnpm forwards this separator: `pnpm harness -- --provider fake`.
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--provider") {
      args.provider = parseProviderFlag(takeValue(argv, ++i, "--provider"));
      continue;
    }
    if (arg === "--model") {
      args.model = takeValue(argv, ++i, "--model");
      continue;
    }
    if (arg === "--max-turns") {
      args.maxTurns = takePositiveInt(argv, ++i, "--max-turns");
      continue;
    }
    if (arg === "--cwd") {
      args.cwd = takeValue(argv, ++i, "--cwd");
      continue;
    }
    if (arg === "--sessions-dir") {
      args.sessionsDir = takeValue(argv, ++i, "--sessions-dir");
      continue;
    }
    if (arg === "--timeout") {
      args.timeoutMs = takePositiveInt(argv, ++i, "--timeout");
      continue;
    }
    if (arg === "--max-output") {
      args.maxOutputChars = takePositiveInt(argv, ++i, "--max-output");
      continue;
    }
    if (arg === "--yolo") {
      args.yolo = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    args.prompt = positional.join(" ");
  }
  return args;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function takePositiveInt(argv: readonly string[], index: number, flag: string): number {
  const raw = takeValue(argv, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return value;
}

function parseProviderFlag(raw: string): "openrouter" | "fake" {
  if (raw === "openrouter" || raw === "fake") return raw;
  throw new Error(`--provider must be "openrouter" or "fake".`);
}
