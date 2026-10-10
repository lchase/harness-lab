/**
 * Neutral chat types shared by every provider.
 * Adapters translate these to a vendor's wire format and back.
 * The core talks only in these types.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON object. Empty when `argumentsError` is set. */
  arguments: Record<string, unknown>;
  /** Set when the model sent arguments we could not parse. */
  argumentsError?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; content: string; toolCallId: string; name: string };

export interface ProviderRequest {
  model: string;
  messages: Message[];
  tools: ToolSchema[];
}

export interface ProviderResponse {
  message: AssistantMessage;
}

/**
 * One model call. Streaming arrives in a later phase; this returns the
 * finished assistant message.
 */
export interface Provider {
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
