---
status: accepted
date: 2026-10-14
---

# PostgreSQL as the datastore and initial work queue

PostgreSQL holds all authoritative state (Users, Bots, grants, Conversations, Jobs, Runs, lineage, triggers, outbox) and is the initial durable work queue for concurrent workers. Redis, NATS, Kafka and other brokers are not required until a measured need appears. This trades a possible database bottleneck and hand-engineered queue semantics for transactional integrity and a simple self-hosted deployment.

## Consequences

- Workers claim Jobs with `SELECT ... FOR UPDATE SKIP LOCKED` in short transactions and never hold a transaction open during a Run.
- Jobs record state (`queued`, `running`, `succeeded`, `failed`, `cancelled`), attempt number, lease owner and token, lease expiry and next eligible time. Workers renew leases; a reaper recovers expired ones.
- Delivery is at-least-once. Fencing tokens and idempotency keys stop a stale attempt from committing authoritative state.
- `LISTEN/NOTIFY` is only a hint to re-query; periodic scans are still required.
- Per-User, per-Bot, per-goal and per-swarm concurrency limits are enforced atomically when claiming.
- External messages go through a transactional outbox. Exactly-once external effects are not guaranteed.
- Large artifacts and runtime checkpoints go to object storage; PostgreSQL stores ownership and references.
- Baseline deployment is single-host Docker Compose with PostgreSQL, an API process and one or more workers. Backups, migrations, restore tests and graceful shutdown are planned from the start.
