---
status: accepted (target capability)
date: 2026-10-14
---

# Open autonomy and persistent goals as a target capability

Bots may initiate work and pursue durable goals without a fresh user message for every action: scheduling future wakeups, reacting to authorized events, adapting plans and recruiting other agents. Open autonomy means open-ended initiative, not unlimited permissions, time or spending. v0.1 ships only user-authorized scheduled Jobs; self-directed goal planning comes later.

## Consequences

- A goal is durable and owner-attributed, separate from any Conversation or Run. A wakeup is a durable request for a future Run, not a long-running LLM process.
- An autonomous Run never expands its own authority; ADR 0001, 0002 and 0003 still govern tools, credentials and data.
- Budgets and quotas (spend, tokens, runtime, concurrency, frequency, swarm size, depth) are enforced by the control plane, outside the LLM.
- Sensitive or irreversible effects need scoped, expiring human approval. Permission to plan is not permission to execute.
- Pausing blocks new work, revocation blocks later protected actions, and cancellation propagates to descendants where feasible.
- Self-trigger storms, no-op wakeups, cycles and runaway Task generation are prevented with deduplication, backoff and rate limits.
- The audit record is structured provenance, not agent-written summaries.
- Retrieved content (email, web, repositories) is untrusted data and never grants authority.
