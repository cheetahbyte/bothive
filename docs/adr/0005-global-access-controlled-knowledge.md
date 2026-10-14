---
status: accepted (target capability)
date: 2026-10-14
---

# One logical, access-controlled knowledge layer

Bothive aims to offer one knowledge discovery and retrieval interface across private-User, private-Bot, shared-collection and swarm scopes. It is global in reach, not in visibility: nothing is public by default, and it does not require one physical database or index. v0.1 only persists scoped data; shared knowledge features come later.

## Consequences

- Storage is private by default. Creating knowledge and publishing it to a broader scope are distinct permissions; publication is never automatic from agent output.
- Access is checked before returning matches, snippets, counts, metadata or content. Private collections must not leak their existence.
- Retrieval uses the requesting actor and the effective Run capabilities; Delegation and swarms never escalate access.
- Embeddings, caches, summaries and derived artifacts are filtered and invalidated on access changes like the source content.
- Provenance and versions are traceable, and unverified agent claims are distinguishable from trusted sources.
- Retrieved content is untrusted data and cannot grant tools, create identities or change goals.
- Do not adopt a vector database or graph engine just because this is called a knowledge layer. Start with owned items, scopes, provenance and basic text search.
