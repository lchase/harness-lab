import type { AssistantMessage, Provider, ProviderRequest, ProviderResponse } from "./types.js";

/**
 * A step in a scripted model conversation.
 * `turnIndex` is 0 for the first `complete` call on this instance.
 */
export type FakeStep =
  | AssistantMessage
  | ((request: ProviderRequest, turnIndex: number) => AssistantMessage);

/**
 * Provider that replays a script. Tests use it in place of OpenRouter.
 * When the script runs out, the next call returns a plain assistant message
 * so a short script cannot spin the loop forever.
 */
export class FakeProvider implements Provider {
  readonly calls: ProviderRequest[] = [];
  private index = 0;

  constructor(private readonly steps: readonly FakeStep[]) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(structuredClone(request));
    const step = this.steps[this.index];
    const turnIndex = this.index;
    this.index += 1;

    if (step === undefined) {
      return {
        message: {
          role: "assistant",
          content: "Fake provider has no further scripted responses.",
        },
      };
    }

    const message = typeof step === "function" ? step(request, turnIndex) : structuredClone(step);
    return { message };
  }
}
