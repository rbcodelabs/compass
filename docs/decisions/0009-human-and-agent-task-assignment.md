# ADR 0009 — Personal agents and task assignment

**Date:** 2026-09-07
**Status:** Accepted design; release pending verification

## Context

Users work across workspaces and organizations and need to assign work to a
human or an external agent without configuring a separate API key per workspace.
The existing User is an Auth.js human account; API keys identify that user and
tasks store an optional human assignee. Assignment and authentication require
different lifecycles.

## Decision

Introduce personal Agent identities owned by a human account. Workspace or
organization administrators explicitly grant READ or WRITE access to an agent
whose owner is a current workspace member. One agent-bound API key works across
those grants, including different organizations. Authentication derives the agent
from the stored key; callers cannot select a different actor.

Effective authority is the intersection of the owner's current access, the
agent's active workspace grant, and credential restrictions. Agent keys cannot
administer identities, permissions, or human approvals. Revoking a workspace
grant does not rotate a key or affect other workspace grants.

Each task has one optional assignee: USER or AGENT. Retain assigneeUserId and
add assigneeAgentId; a shared setter updates both atomically. Preserve legacy
human assignment input and URLs. No task backfill is needed. Assignment does not
start execution or confer access. Unavailable assignees remain visible until
someone explicitly clears or replaces them.

Agent identity is durable across renaming, model/runtime changes, and key
rotation. Owners manage their agents and keys; workspace administrators manage
grants. Owners cannot transfer agent ownership in this release. Suspended agents
retain their assignments and history.

Registered-agent mutation calls receive server-side activity records. The log
distinguishes an attempted operation from success, denial, failure, or an
unrecorded final outcome. It contains no credentials or raw tool arguments and
does not claim that a successful tool call completed the assigned task.

The built-in assistant remains unregistered. Newly issued turn credentials are
workspace-scoped and expire after five minutes independently of cleanup.

## Options considered

| Approach | Benefit | Cost |
|---|---|---|
| Synthetic User accounts for agents | Reuses human membership and assignee fields | Conflates login, ownership, and attribution |
| Personal Agent plus explicit workspace grants | One key spans organizations; additive migration | Every authorization and aggregate query must account for grants |
| Organization agents and a multi-agent connection broker | Supports team identities and orchestrator delegation | More credential infrastructure and integration work than the approved release |

## Consequences and limits

- Existing personal and service credentials remain separate from registered agents.
- Membership removal revokes associated workspace grants; rejoining requires a new grant.
- Losing one organization does not delete a personal agent used elsewhere.
- DSQL integrity is enforced through shared application services and tested migrations.
- Already authorized operations are not cancelled by later revocation.
- No automatic dispatch, Geode changes, multi-agent keys, run scheduler, or ownership transfer.
- Historical API keys and audit entries are not heuristically relabeled.
- Agent credentials append comments but cannot rewrite existing comment bodies:
  legacy/shared comment records lack durable agent ownership. This preserves
  human attribution and legacy approval labels until an ownership model exists.

## Delivery and rollback

Install the additive registered migration and verify async indexes before
enabling COMPASS_AGENTS_ENABLED=1. Keep human assignment compatible throughout.
The migration must be complete before this application revision receives user
traffic: the feature flag does not hide new columns from existing Prisma reads.
Use a staged, unpromoted deployment exposing the registered migration endpoint,
apply the exact migration in the target environment, verify it, then promote
traffic. A direct auto-promoted production deployment is not a safe rollout.
Disabling new agent authentication/assignment must preserve stored assignments.
Rollback targets must understand both assignment columns; do not roll back to
an older writer that can populate both columns. No destructive down migration.

## Database references

The migration retains this repository's application-managed relations and UUID
keys. Inline state checks follow the supported [Aurora DSQL CREATE TABLE
syntax](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html).
Standalone indexes use the repository's asynchronous-index runner, with catalog
readback required before recording completion.
