---
status: accepted
date: 2026-10-14
---

# Dual external bot identity: dedicated accounts and shared gateways

A Bot is an internal identity, independent of external credentials. A Connection can be a Dedicated account (bound to one Bot) or a Shared gateway (routing to several Bots), and both can be mixed. These are Bindings, not different kinds of Bot, so Bot IDs are never coupled to platform user or application IDs.

## Consequences

- Inbound events carry connection ID, External actor ID, external conversation ID and platform message ID. Identity and authorization are resolved before a Run starts.
- Routing is deterministic. Ambiguous or unaddressed messages get an explicit fallback or an ambiguity outcome, never an arbitrary Bot.
- Replies always keep internal author identity. Shared gateway replies label the authoring Bot; platform impersonation is not an identity guarantee.
- Credentials stay in the Channel adapter and control plane, never in prompts, tool context or delegated Tasks.
- Conversations and bot memory stay scoped per Bot even when Bots share an external channel.
- Delegation is internal and provenance-tracked; it never travels through Discord or Telegram.
- Deduplication, outbound retries, rate limits and disconnects are Channel adapter concerns. Delivery is at-least-once.
- Authenticating an External actor does not authorize access to any Bot by itself.
