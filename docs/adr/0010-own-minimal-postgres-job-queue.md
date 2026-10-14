---
status: accepted
date: 2026-10-14
---

# A minimal in-house Job queue instead of pg-boss or graphile-worker

We implement our own small Job queue on PostgreSQL (`SKIP LOCKED` claims, renewable leases, fencing tokens) rather than adopting pg-boss or graphile-worker. ADR 0008 requires fencing tokens checked when results commit, per-Conversation, per-Bot and per-User concurrency limits enforced atomically at claim time, and Job state written in the same transaction as Run lineage and re-authorization. Those rules are domain logic that would fight a library's own job model.

## Consequences

- We own lease, retry, reaper and backoff correctness, so those paths need focused tests against a real PostgreSQL.
- Revisit this if the queue grows features that a library already provides well, such as cron scheduling or job dashboards.
