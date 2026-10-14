---
status: accepted
date: 2026-10-14
---

# Multi-user bot ownership with explicit sharing

Bothive supports multiple Users. Every Bot has one Owner, starts private, and is shared only through explicit, revocable Access grants. Organizations, workspaces and public discovery are not prerequisites. We chose this over a single-user design so that platform identity, ownership and conversation privacy are never conflated; cross-user data leakage is the primary design risk.

## Consequences

- v0.1 grant roles are Owner and Member. An Editor role may come later.
- Authorization covers every path (messages, background Jobs, Delegation, tool calls), not only the API surface.
- A User's Conversations and user-scoped memory stay private even when the Bot is shared. The Owner has no blanket access to a Member's Conversations.
- Sharing a Bot never shares credential values or personal connectors.
- Delegation never widens privileges; the target Bot authorizes the requesting actor independently.
- Outbound and proactive delivery is authorized for its recipient and destination.
- Revocation applies to future access and queued work. In v0.1 a Run in progress finishes, but its reply is re-authorized before it is stored or delivered.
- The Instance admin is distinct from Bot ownership and gets no product-level view of Conversations.
- Unlinked External actors never receive a User's privileges.
