import type { Conversation } from "../conversations/conversations.ts";
import type { Job } from "../conversations/jobs.ts";
import type { Message } from "../conversations/messages.ts";
import type { Bot } from "../identity/bots.ts";

export type RuntimeCapabilities = {
  tools?: boolean;
  streaming?: boolean;
};

export type RuntimeUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type RuntimeEvent =
  | { type: "output_text"; text: string }
  | { type: "usage"; usage: RuntimeUsage }
  | { type: "completed" }
  | { type: "failed"; error?: string; reason?: string; retryable?: boolean };

export type RunRequest = {
  bot: Bot;
  conversation: Conversation;
  job: Job;
  messages: Message[];
};

export interface AgentRuntime {
  readonly id: string;
  capabilities(): RuntimeCapabilities;
  execute(request: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
}
