---
status: accepted
date: 2026-10-14
---

# Pluggable Channel adapters around a transport-neutral core

Discord, Telegram, inline.chat and future first-party mobile and desktop clients connect through Channel adapters. Bot identity, Conversations, scheduling and orchestration stay transport-neutral. Discord is the v0.1 reference adapter; a mock adapter exercises the same contract without platform SDKs. Universal feature parity across platforms is explicitly not promised.

## Consequences

- Adapters own transport, platform authentication and webhooks, event normalization, rate limits, reconnects and delivery acknowledgements. No platform SDK types cross into core.
- Core concepts (messages, actors, attachments, Conversations, commands, edits, delivery status) are normalized, while adapters publish capability descriptors instead of silently dropping features.
- Inbound events are authenticated and deduplicated by Connection and platform event ID. Each event routes to exactly one Bot or returns an explicit ambiguity outcome.
- User, Bot, Conversation and delivery target are authorized before execution or outbound publication, identically for adapters and the first-party API.
- Outbound delivery uses the PostgreSQL outbox (ADR 0008) with retries and audit.
- Discord routing activates on explicit selection by default (slash command, mention, reply, DM). Listening to unmentioned channel messages requires Instance admin opt-in per channel. Messages from other bots are ignored by default to avoid loops.
- AG-UI is a candidate realtime protocol for first-party clients, not a replacement for durable domain events.
