---
status: accepted (target capability)
date: 2026-10-14
---

# Dynamic multi-agent swarms as a target capability

Bothive aims to let authorized Bots assemble temporary teams, decompose work into Tasks, run them concurrently and synthesize results. Explicit Delegation is the foundation and ships first; swarms are a direction, not an MVP commitment. A swarm is a capability to use when it pays off, not a default for every request.

## Consequences

- An agent instance is a bounded execution participant. It never becomes a persistent Bot, gains an external account, or receives ownership without a separate control-plane operation.
- Every swarm has an accountable initiating principal. Effective permissions are the intersection of initiator authority and each participant's grants; spawning never expands privileges.
- Budgets, maximum participants, delegation depth, duration and concurrency are enforced to prevent unbounded recursion.
- Task state and parent-child Run lineage are durable. Retries assume at-least-once, not exactly-once, side effects.
- Cancellation propagates to queued and active descendants; committed external side effects may need compensation.
- Shared context is explicit and minimal; participants never inherit another User's Conversations, memory or secrets.
- Delivery order: Delegation with lineage and cancellation, then parallel Tasks and ephemeral instances, then dynamic team formation and peer messaging.
