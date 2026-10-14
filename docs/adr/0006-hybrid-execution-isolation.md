---
status: accepted
date: 2026-10-14
---

# Hybrid execution isolation: shared trusted workers, sandboxed untrusted tools

Shared workers run trusted agent runtime logic, model calls and tool dispatch. Shell, generated code, browser automation and local or third-party MCP executables run in isolated sandboxes chosen per operation and trust boundary, not one container per Bot. We chose this over per-agent isolation for lower startup cost and better utilization, accepting a hard dependency on a correct tool broker. Containers are not assumed to be VM-equivalent isolation.

## Consequences

- No model-generated code or untrusted plugin code runs in shared workers.
- Every tool call goes through a central tool broker that checks the effective User, Bot, Conversation, goal, Run and delegated authority, including after wakeups and Delegation.
- Default sandbox: non-privileged user, no host process namespace or Docker socket, restricted filesystem, resource and time limits, policy-limited egress, and no inherited home directories, host credentials, SSH agents or cloud metadata.
- Sandboxes cannot reach the control-plane admin API or private services through the host network.
- Tool output, files and remote MCP replies are untrusted data with size limits and provenance.
- Cancellation terminates sandbox workloads. Sandboxes are not reused across mutually untrusted Users without validated teardown.
- Reviewed hosted connectors (for example GitHub) may run outside a sandbox but still pass the broker.
- The Instance admin remains infrastructure-trusted; product privacy controls do not protect against a malicious host operator.
- Arbitrary code execution is not offered to mutually untrusted Users until containment is validated.
