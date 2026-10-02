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

PR 1 covers identity, workspaces, opportunities, solutions, assumptions,
feedback, tasks, and roadmap items. Later API program phases add strategy,
learning, collaboration, governance, and research resources. The MCP endpoint
remains supported and unchanged.

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
