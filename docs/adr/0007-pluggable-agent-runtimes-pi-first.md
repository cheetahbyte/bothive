---
status: accepted
date: 2026-10-14
---

# Pluggable Agent runtimes behind a narrow contract, Pi first

Bothive defines a small internal execution contract and implements Pi as the first Agent runtime. We do not build our own model and tool loop, and we do not design a universal agent SDK. A small common interface with optional, negotiated capabilities beats flattening every engine into the lowest common denominator, and it lets core tests run against a fake runtime without an LLM.

```typescript
interface AgentRuntime {
  readonly id: string;
  capabilities(): RuntimeCapabilities;
  execute(request: RunRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
}
```

## Consequences

- Bothive core owns identities, grants, Jobs, lineage, scheduling, cancellation requests, tool brokerage, credentials, audit and routing. The runtime owns the agent loop, model mapping, context assembly, event normalization and translating cancellation.
- Bothive stores canonical Conversation and Run state. Runtime checkpoints are opaque, versioned artifacts and not portable across runtimes.
- Every tool call made by a runtime goes through the tool broker (ADR 0006). Pi's built-in shell and file tools are disabled or replaced in shared workers.
- No Pi types leak into core packages. The Pi adapter is isolated, and the SDK version is pinned and tested against installed behavior.
- A stream that ends without a completion event is a failure. Each Run has an unambiguous terminal state.
- The runtime is recorded per Bot and Run. The scheduler rejects unsupported required capabilities explicitly.
- Non-goals: hot-swapping engines mid-Run, migrating checkpoints between runtimes, and a second production runtime before Pi is validated.
