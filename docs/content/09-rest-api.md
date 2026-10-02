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
- Collections return `{ "items": [], "nextCursor": null }` and accept an
  opaque `cursor` plus `limit` (default 50, maximum 100).
- Boolean query parameters use the exact URL strings `true` and `false`; other
  spellings are rejected. A cursor is bound to its collection, filters, and
  page size, so clients must keep the same `limit` while paging. Decision
  requests use a maximum `limit` of 50 because their shared service is
  page-number based.
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
