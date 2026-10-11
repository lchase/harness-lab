import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import { runLoop, SessionLog } from "../core/index.js";
import { OpenRouterProvider, type Provider } from "../provider/index.js";
import { createAgentTools, systemPrompt } from "./agent.js";
import { HELP, parseArgs } from "./args.js";
import { resolveConfig } from "./config.js";
import { createDemoProvider } from "./demo.js";
import { printEvent } from "./print.js";
import type { Message } from "../provider/types.js";

export interface MainIO {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export async function main(argv: readonly string[], io: MainIO = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const prompt = args.prompt;
  if (!prompt) {
    console.log(HELP);
    return 1;
  }

  const env = io.env ?? process.env;
  const config = resolveConfig(args, env, io.cwd ?? process.cwd());
  const provider = createProvider(config);
  const session = SessionLog.create(config.sessionsDir, {
    cwd: config.cwd,
    model: config.model,
  });

  console.log(`provider=${config.provider} model=${config.model}`);
  console.log(`session=${session.path}`);

  const messages: Message[] = [
    { role: "system", content: systemPrompt(config.cwd) },
    { role: "user", content: prompt },
  ];

  try {
    const result = await runLoop({
      provider,
      model: config.model,
      messages,
      tools: createAgentTools(),
      cwd: config.cwd,
      maxTurns: config.maxTurns,
      timeoutMs: config.timeoutMs,
      maxOutputChars: config.maxOutputChars,
      onEvent: printEvent,
      session,
    });
    return result.stopReason === "completed" ? 0 : 1;
  } finally {
    session.close();
  }
}

function createProvider(config: ReturnType<typeof resolveConfig>): Provider {
  if (config.provider === "fake") {
    return createDemoProvider();
  }
  if (!config.apiKey) {
    throw new Error("Set OPENROUTER_API_KEY, or run with --provider fake.");
  }
  return new OpenRouterProvider({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    });
}
