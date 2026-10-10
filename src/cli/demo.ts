import { FakeProvider, type FakeStep } from "../provider/fake.js";
import type { AssistantMessage, ProviderRequest } from "../provider/types.js";

/**
 * Built-in script for `--provider fake`.
 * Turn 1 runs a fixed bash command. Turn 2 replies with that command's output.
 * The prompt is stored on the session and echoed back; it does not choose the command.
 */
export function createDemoProvider(): FakeProvider {
  const steps: FakeStep[] = [
    {
      role: "assistant",
      content: "I'll run a command in the working directory.",
      toolCalls: [
        {
          id: "call_demo",
          name: "bash",
          arguments: { command: "printf 'hello from harness\\n'" },
        },
      ],
    },
    (request: ProviderRequest): AssistantMessage => {
      const toolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
      const output = toolMessage?.role === "tool" ? toolMessage.content : "(no tool result)";
      const userMessage = request.messages.find((message) => message.role === "user");
      const asked = userMessage?.role === "user" ? userMessage.content : "";
      return {
        role: "assistant",
        content: `Done. You asked: ${asked}\n${output}`,
      };
    },
  ];
  return new FakeProvider(steps);
}
