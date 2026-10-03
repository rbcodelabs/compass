---
title: "REST API"
description: "Integrate with Compass through a resource-oriented JSON API"
icon: "Braces"
order: 9
section: "Developer"
---

# REST API

Compass exposes a versioned, resource-oriented JSON API at `/api/v1`. Its
OpenAPI 3.1 description is public at:

```
GET /api/v1/openapi.json
```

API v1 currently covers identity and workspaces; discovery and delivery;
strategy, learning, metrics, scoring, squads, custom fields, and typed links;
and the Phase 3 collaboration surface for comments, notifications, Docs,
artifacts, decision/review requests, solution plans, launch checklists, and
release-authorization requests. The MCP endpoint remains supported and
unchanged.

Phase 4 adds research studies, saved sessions and transcript turns, completed
syntheses and evidence promotion; initiating-owner PM interview reads;
analytics connections; and card-sort rounds, blind proposals, tallies, and
new-entry resolution. Consult OpenAPI for the exact route and DTO inventory.

Human judgment and execution boundaries are deliberate. REST clients may
request a decision or release authorization and read its state, but cannot
record a human decision, apply a recorded decision, approve or reject a
solution plan, or dispatch a release. Those operations remain human-only or
inside the separately authorized release workflow.

## Authentication

Send a Compass API key or an OAuth access token in the bearer header:

```
Authorization: Bearer <token>
```

OAuth clients must request resource `/api/v1` and `api:read` or `api:write`.
`api:write` includes read access. Tokens minted for `/api/mcp` cannot call the
REST API, and tokens minted for `/api/v1` cannot call MCP. Existing static API
keys retain their programmatic identity and workspace grants across both
transports.

Protected-resource metadata is published at
`/.well-known/oauth-protected-resource/api/v1`.

## Conventions

- Resource paths use plural kebab-case under `/api/v1/workspaces/{workspaceId}`.
- General collections return `{ "items": [], "nextCursor": null }` and accept
  an opaque `cursor` plus `limit` (default 50, maximum 100). Decision-request
  collections are the explicit exception and cap `limit` at 50 to match their
  bounded shared service.
- Boolean query parameters use the exact URL strings `true` and `false`; other
  spellings are rejected. A cursor is bound to its collection, filters, and
  page size, so clients must keep the same `limit` while paging; a cursor from
  a general collection cannot be reused for a differently sized decision page.
- Reads and updates return `200`, creation returns `201`, and supported deletion
  returns `204`.
- Errors use RFC 9457 `application/problem+json`, including a stable `code` and
  sanitized validation `issues` where applicable.
- Authenticated responses send `Cache-Control: no-store`.
- A resource that does not exist and one the caller cannot access both return
  the same non-disclosing `404` response.

The OpenAPI document is the authoritative list of operations and request and
response schemas. Resource names, operation IDs, field casing, pagination, and
problem codes are compatibility contracts for API v1.

## Docs concurrency and idempotency

Doc creation requires a UUID `operationId`. Doc update, version creation, and
version restore require both `operationId` and the current `expectedRevision`.
These fields make retries idempotent and prevent stale writers from overwriting
newer content, including workspaces backed by the GEODE document store. Reusing
an operation ID for a different payload or sending a stale revision returns
`409`; missing/invalid operation tokens return `422`.

## Release authorization

`POST /api/v1/workspaces/{workspaceId}/release-authorizations` prepares an
immutable human review request for an exact repository, commit, environment,
policy, and same-workspace task set. It does not merge, deploy, mutate tasks, or
dispatch a release. Clients can inspect the resulting request and release run;
actual dispatch remains outside the REST API and requires separately recorded
human authorization plus the release workflow's revalidation.

## Research, analytics, and card sorting

Research-study creation always creates a draft. Activating a study, issuing a
participant link, or rotating a participant link is an explicit human-member
action. The returned participant URL contains a one-time credential and is only
returned by that successful action; list and get responses never return tokens,
hashes, participant identity, audio locations, or voice-processing state.
Revocation returns no replacement credential. PM interviews do not appear in
ordinary research endpoints, and the dedicated PM interview read is restricted
to the user who initiated it.

Session, transcript-turn, and synthesis collections use signed opaque cursors
bound to the workspace, study, filters, ordering, and page size. Keep `limit`
unchanged when following `nextCursor`. Only completed synthesis content is
readable; pending/failed claim data, fingerprints, model and prompt metadata,
and generation leases are excluded. Invalid or mismatched cursors return the
RFC 9457 `invalid_cursor` problem with status `400`.

Analytics connection reads expose connection health and project identity only.
Saving/rotating or disconnecting a provider credential requires a human
workspace administrator. Provider tokens and encrypted secrets are never
returned.

All card-sort endpoints require a human workspace member. While a round is
open, callers see only their own proposals unless they are the facilitator.
Reveal is irreversible, close prevents further writes, and facilitator-only
state changes and new-entry decisions are transactionally fenced against races.
Card-sort domain errors are returned as typed RFC 9457 problems.

The REST surface intentionally excludes participant response/voice/attachment
protocols, transcript editing, raw pending synthesis state, participant-token
retrieval, PM interview creation/update/application, generic card-sort state
patching or unreveal, model-generated research guides, and provider secrets.
