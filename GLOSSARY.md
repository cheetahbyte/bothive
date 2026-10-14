# Bothive

Bothive is a self-hostable platform for running multiple persistent, independently owned AI bots that can talk to people through messaging channels and delegate work to each other.

## Identity and access

**Bot**:
A durable internal identity with its own configuration, capabilities, policy and history, independent of any external messaging account.
_Avoid_: Agent, assistant (when meaning the persistent identity)

**User**:
An authenticated human principal inside Bothive, independent of any external platform account.
_Avoid_: Account, member (when meaning the person)

**Access grant**:
An explicit, revocable role given to one User on one Bot.
_Avoid_: Permission, share

**Owner**:
The single accountable User of a Bot, who manages its configuration, lifecycle and Access grants.

**Member**:
The Access grant role that lets a User interact with a shared Bot and see only their own Conversations.
_Avoid_: User (as a role name), Editor

**Instance admin**:
The operator of a Bothive deployment, who creates Users and issues their credentials but has no product-level access to Conversations.
_Avoid_: Admin (unqualified), superuser

**External actor**:
A human or bot identified on an external platform, untrusted until linked to a User.

**External identity link**:
A verified mapping from an External actor to a User.

## Channels

**Channel adapter**:
The component that connects one external messaging platform or client to Bothive.
_Avoid_: Integration, connector

**Connection**:
One authenticated platform account or transport instance, such as a single Discord application token.

**Binding**:
A rule that maps a Connection, plus optional channel or mention context, to a Bot.

**Dedicated account**:
A Connection bound to exactly one Bot.

**Shared gateway**:
A Connection that routes to several Bots and labels each reply with its authoring Bot.

## Work and execution

**Conversation**:
A scoped message history with its participants, owned by Bothive and separate from Bot identity.
_Avoid_: Session, chat, thread

**Task**:
A domain unit of work with input, output and lineage, assigned to one participant.
_Avoid_: Job (when meaning the work itself)

**Job**:
A durable queue record that schedules and leases execution; a Task or trigger may produce several Jobs.
_Avoid_: Task (when meaning the queue record)

**Run**:
One bounded attempt at agent execution by an Agent runtime.
_Avoid_: Session, execution

**Delegation**:
One Bot asking another Bot to perform a bounded Task, with recorded provenance.

**Agent runtime**:
A pluggable backend that executes the agent loop for a Run behind Bothive's execution contract.
_Avoid_: Engine, framework

**Runtime checkpoint**:
Opaque, runtime-specific saved state for a Run, never treated as canonical Conversation history.
_Avoid_: Session
