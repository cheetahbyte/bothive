import type { AgentRuntime } from "./types.ts";

export interface RuntimeRegistry {
  register(runtime: AgentRuntime): void;
  get(id: string): AgentRuntime | undefined;
  has(id: string): boolean;
  list(): AgentRuntime[];
}

export function createRuntimeRegistry(initialRuntimes: AgentRuntime[] = []): RuntimeRegistry {
  const map = new Map<string, AgentRuntime>();
  for (const runtime of initialRuntimes) {
    map.set(runtime.id, runtime);
  }
  return {
    register(runtime: AgentRuntime) {
      map.set(runtime.id, runtime);
    },
    get(id: string) {
      return map.get(id);
    },
    has(id: string) {
      return map.has(id);
    },
    list() {
      return Array.from(map.values());
    },
  };
}
