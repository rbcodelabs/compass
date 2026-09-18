# ADR 0014 — Compass Is Its Own OAuth Authorization Server

- **Status:** Accepted
- **Date:** 2026-09-18
- **Target spec revision:** MCP **2026-07-28**
- **Scope:** Add MCP-conformant OAuth 2.1 discovery and authorization to
  `POST /api/mcp`, so a client can connect with a URL alone. This decision does
  **not** change the tool catalog, the `McpActor` authorization model, any
  `TOOL_GATES` entry, or any existing `cmp_…` API key behavior. Static keys and
  `MCP_API_KEY` service-account behavior remain supported indefinitely.
- **Design of record:** `docs/design/mcp-oauth-discovery.md`

## Context

Compass's MCP endpoint has only ever authenticated a static bearer token:
`MCP_API_KEY`, or a per-user `cmp_<32 hex>` key looked up by prefix and SHA-256
hash in `lib/mcp-auth.ts`. That is not a spec violation — *"Authorization is
OPTIONAL for MCP implementations"* — but it has a cost. The 401 carried a bare
`WWW-Authenticate: Bearer` with no `resource_metadata` parameter, so a client had
nothing to discover, and connecting required a human to generate a key in
Settings and paste it into a config file.

The goal is that pasting `https://compass.rbcodelabs.com/api/mcp` into a client
is sufficient: the user is bounced to a Compass login and consent screen,
approves, and is connected.

Reaching that requires an authorization server. There were three ways to get
one.

## Decision

**Be our own authorization server, on the same origin.** Issuer, resource
server, and identity provider are all `compass.rbcodelabs.com`.

### Why not delegate to Google

Rejected on fetched evidence, not on preference.
`https://accounts.google.com/.well-known/openid-configuration` shows:

| Capability | Present? | Consequence |
|---|---|---|
| `registration_endpoint` | **No** | No DCR — no MCP client can register |
| `client_id_metadata_document_supported` | **No** | No CIMD either, so there is no registration path at all |
| `"none"` in `token_endpoint_auth_methods_supported` | **No** | Public loopback clients cannot authenticate |
| RFC 8707 resource indicators | **No** | Google will never mint a token whose audience is `https://compass.rbcodelabs.com/api/mcp` |

The last row is decisive on its own. Accepting a Google-issued token anyway
would violate the spec's hardest MUST — *"MCP servers MUST NOT accept any tokens
that were not explicitly issued for the MCP server"* — which is precisely the
confused-deputy class of bug the audience requirement exists to prevent. It
would also strand every Resend magic-link user, who has no Google identity at
all.

Google remains an upstream *identity* source through NextAuth. That is a
different role from being the authorization server for this resource, and it is
the architecture the spec recommends.

### Why not buy a hosted authorization server

Auth0, WorkOS, Stytch, Scalekit and Entra ID all speak RFC 8707 plus DCR or
CIMD, so any of them is technically viable. The objection is an identity split,
not a feature gap.

Compass already owns `User`, `OrganizationMember` and `WorkspaceMember`, and
every MCP gate in `lib/mcp-tool-gates.ts` resolves against those rows. A hosted
AS introduces a second system of record for identity, and therefore a sync
problem, a vendor, and a bill — to avoid roughly 600 lines of code.

Owning it instead makes the central property of this design possible: tokens map
1:1 onto the existing `McpActor`, so `validateMcpAuth` gains one branch and
**`lib/mcp-authz.ts` and every per-tool gate are untouched**. An OAuth token is
just another way to name an actor the system already understands, which means
every membership assertion and the "not found or access denied" non-disclosure
behavior carry over for free.

## Consequences and sub-decisions

### DCR only; CIMD is not scheduled

MCP 2026-07-28 deprecates Dynamic Client Registration in favor of Client ID
Metadata Documents. Compass ships DCR anyway, and does **not** advertise
`client_id_metadata_document_supported`.

This is not inertia. CIMD alone does not work against any client Compass cares
about today:

- The Geode / Agent Threads broker — the primary consumer — is DCR-only. Its
  `OAuthMcpRegistry.ts` hard-fails when `registration_endpoint` is absent, and
  there is no CIMD code path anywhere in it. `registration_endpoint` is
  therefore a *blocking* requirement, not a compatibility nicety.
- Per Anthropic's connector documentation, Claude takes the CIMD path only when
  the metadata advertises **both** `client_id_metadata_document_supported: true`
  **and** `"none"` in `token_endpoint_auth_methods_supported`; missing either, it
  falls back to DCR.
- `mcp-remote` cannot perform CIMD at all (geelen/mcp-remote#224), and
  `@modelcontextprotocol/sdk@1.26.0` has no server-side CIMD support to build on.

So DCR alone is complete coverage, and advertising CIMD would make Claude attempt
a flow that does not exist rather than falling back to one that does.
Deprecated MCP features get at least 12 months, so this is not near-term
pressure. Revisit when a client Compass wants actually requires CIMD, or when
DCR's removal date firms up; the migration is purely additive.

Related, and easy to get wrong in the other direction: never emit
`"registration_endpoint": null` or `"…_supported": false` for something
unimplemented. Claude Code Zod-fails on a null here
(anthropics/claude-code#38102). Omit unsupported keys entirely.

### No static client

DCR is the one registration path. A pre-seeded, verified "Agent Threads" client
would save a single HTTP round trip and improve some consent wording, but it
removes none of the hard requirements — Geode still binds an ephemeral loopback
port on every authorization, so port-agnostic redirect matching is needed either
way — and it adds cross-repo coupling on a shared constant. Two registration
paths is a worse trade than one round trip.

The consequence is that Compass accumulates one `OAuthClient` row per install,
all named "Agent Threads", and that *every* client is dynamic and unverified.
That makes two things load-bearing rather than optional: `/register` rate
limiting and TTL pruning, and the consent screen's unverified treatment. The
redirect host is the only signal on that screen an attacker cannot forge, so it
is shown prominently, and the "unverified" badge appears on every client —
never only on some, which would train people to read its absence as an
endorsement.

### No workspace picker on consent

An OAuth token carries exactly the reach a per-user `cmp_…` key already has:
every workspace the user belongs to, across every organization. Adding a picker
would invent a second scoping concept alongside one that already works, and
`assertActorWorkspaceScope` is already there if we want to narrow it later —
existing tokens carry `scopeWorkspaceId: null`, meaning "all memberships", so
narrowing stays additive.

**In exchange, the consent screen enumerates the organizations and workspaces
being granted, by name.** The grant spans organizations, which is broader than
"Connect Compass" sounds, and naming them is nearly free.

### Scopes: `mcp:read`, `mcp:write`, `offline_access`, and nothing else

`TOOL_SCOPES` in `lib/mcp-tool-gates.ts` classifies all 153 registered tools as
one or the other, with the same fail-closed completeness test `TOOL_GATES` has.
It is kept deliberately separate from `AGENT_TOOL_POLICY`, which looks similar
and answers a different question ("may a delegated agent identity do this at
all?") — its DENY entries happen to all be writes, but "human-only" and
"mutating" are not the same predicate.

`scopes_supported` stays short because a client that receives no `scope`
parameter in the challenge requests *everything* listed there. Each extra
advertised scope is consent surface granted by default.

That is also why the resource server hand-rolls its `WWW-Authenticate` header
rather than using `mcp-handler`'s `withMcpAuth`, which never emits `scope` even
when `requiredScopes` is set (and whose `required` option defaults to `false`,
and whose `resourceMetadataPath` does no RFC 9728 path insertion). Scope
failures are **403** with `error="insufficient_scope"`, not 401: Claude ignores
`WWW-Authenticate` on a 200, and re-authenticating cannot fix a scope shortfall.

### `resource` is accepted leniently

Absent → default the audience to the canonical MCP resource URI; present and
matching → use it; present and different → reject with `invalid_target`.

The spec says clients MUST send `resource`, but the Geode broker never does, at
authorize or at token exchange, and neither does `mcp-remote`. Rejecting on
absence would break the primary consumer on day one. Nothing is given up:
`resource` exists to let an AS disambiguate between several resources, and this
AS serves exactly one. The audience is still bound onto the token and still
enforced on every single request by `validateMcpAuth`, which is where the
security property actually lives.

### Refresh tokens are issued unconditionally

Never gated on `offline_access`. The Geode broker requests the `refresh_token`
grant at registration but does not append that scope, and its proxy depends on
refresh to recover from an upstream 401 — gating would leave every Geode user
re-authorizing by hand every hour. `offline_access` is still advertised in the
AS metadata, because Claude gates its *request* for a refresh token on seeing it.

## Verification

- **Unit:** PKCE verification, single-use codes under concurrency, redirect URI
  matching (exact plus loopback port-agnostic), refresh rotation with reuse
  detection, audience rejection, `TOOL_SCOPES` completeness, and the 401/403
  challenge shapes.
- **Integration:** `scripts/oauth-mcp-probe.ts` walks the real chain against a
  running deployment — unauthenticated 401 → both PRM URLs → both AS metadata
  URLs → DCR → authorize + consent → token exchange → `initialize` → foreign
  audience rejected. This is exactly what a real client does, and it is the
  highest-value artifact in the phase.
- **Manual:** a per-client acceptance matrix (Geode, Claude, `mcp-remote`,
  Cursor/VS Code). Note that Vercel Deployment Protection intercepts preview
  requests before Compass sees them, so preview OAuth testing requires
  protection *disabled* on that preview — a bypass secret is not enough, because
  neither Geode nor Claude can attach one to its discovery requests.

## Not in this decision

Refresh rotation telemetry, a "Connected apps" panel in Settings, `/register`
abuse response beyond the existing rate limit, workspace-scoped consent, a
verified-client allowlist, CIMD, and an authorization audit log. All are
additive to what is built here.
