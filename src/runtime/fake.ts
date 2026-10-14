import type {
  AgentRuntime,
  RunRequest,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeUsage,
} from "./types.ts";

export type FakeScript = {
  reply?: string;
  usage?: RuntimeUsage;
  fail?: string | Error;
  hang?: boolean;
  endEarly?: boolean;
  events?: RuntimeEvent[];
  onExecute?: (signal: AbortSignal) => void;
};

export class FakeAgentRuntime implements AgentRuntime {
  readonly id = "fake";

  private botScriptQueues = new Map<string, FakeScript[]>();
  private botPersistentScripts = new Map<string, FakeScript>();
  private defaultHandler:
    | ((request: RunRequest, signal: AbortSignal) => AsyncIterable<RuntimeEvent>)
    | null = null;

  capabilities(): RuntimeCapabilities {
    return { tools: false, streaming: true };
  }

  scriptBot(botId: string, script: FakeScript): this {
    const queue = this.botScriptQueues.get(botId) ?? [];
    queue.push(script);
    this.botScriptQueues.set(botId, queue);
    return this;
  }

  setBotScript(botId: string, script: FakeScript | null): this {
    if (script === null) {
      this.botPersistentScripts.delete(botId);
    } else {
      this.botPersistentScripts.set(botId, script);
    }
    return this;
  }

  setDefaultHandler(
    handler: ((request: RunRequest, signal: AbortSignal) => AsyncIterable<RuntimeEvent>) | null,
  ): this {
    this.defaultHandler = handler;
    return this;
  }

  reset(): void {
    this.botScriptQueues.clear();
    this.botPersistentScripts.clear();
    this.defaultHandler = null;
  }

  async *execute(request: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (this.defaultHandler) {
      yield* this.defaultHandler(request, signal);
      return;
    }

    const queue = this.botScriptQueues.get(request.bot.id);
    const script = queue?.shift() ?? this.botPersistentScripts.get(request.bot.id);

    if (script?.onExecute) {
      script.onExecute(signal);
    }

    if (!script) {
      const lastMessage = request.messages[request.messages.length - 1];
      const replyText = lastMessage ? `Echo: ${lastMessage.content}` : "Hello from Bot!";
      yield { type: "output_text", text: replyText };
      yield {
        type: "usage",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
      yield { type: "completed" };
      return;
    }

    if (script.events) {
      for (const event of script.events) {
        if (signal.aborted) throw new Error("aborted");
        yield event;
      }
      return;
    }

    if (script.hang) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (signal.aborted) {
        throw new Error("aborted");
      }
      return;
    }

    if (script.fail) {
      const errorMsg = typeof script.fail === "string" ? script.fail : script.fail.message;
      yield { type: "failed", error: errorMsg };
      return;
    }

    if (script.reply !== undefined) {
      yield { type: "output_text", text: script.reply };
    }

    if (script.usage) {
      yield { type: "usage", usage: script.usage };
    } else {
      yield {
        type: "usage",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }

    if (script.endEarly) {
      return;
    }

    yield { type: "completed" };
  }
}

export const fakeRuntime = new FakeAgentRuntime();
