# Design — Discoverable OAuth for the Compass MCP Server

- **Status:** Proposed (not implemented)
- **Date:** 2026-09-12
- **Target spec revision:** MCP **2026-07-28** (current; substantively identical
  to `draft` for authorization)
- **Primary consumer:** the OAuth MCP broker already shipped in Geode / Agent
  Threads (`obsidian-claude-threads`, `src/OAuthMcpFlow.ts`). Its observed
  behavior is normative for this design — see *Client profile* below.
- **Scope:** Add MCP-conformant OAuth 2.1 discovery and authorization to
  `POST /api/mcp`, so an MCP client can connect with a URL alone. Does not
  change the tool catalog, the `McpActor` authorization model, or any existing
  `cmp_…` API key behavior.

## Context — what exists today

Compass's MCP endpoint authenticates with a **static bearer API key only**.

| Concern | Current state | File |
|---|---|---|
| Token validation | `MCP_API_KEY` env var, or a per-user `cmp_<32 hex>` key looked up by `keyPrefix` + SHA-256 `keyHash` | `lib/mcp-auth.ts` |
| Acting identity | `McpActor { userId, purpose, scopeWorkspaceId }` carried via `AsyncLocalStorage` | `lib/mcp-authz.ts` |
| Per-tool policy | Fail-closed gate map; every registered tool (145 at time of writing) must have an entry | `lib/mcp-tool-gates.ts` |
| Key issuance | `createApiKey` server action, Settings UI, shown once | `app/[orgSlug]/[workspaceSlug]/settings/actions.ts` (`createApiKey`) |
| 401 response | `new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })` | `app/api/mcp/route.ts` (local `withMcpAuth`) |
| Middleware | `/api/mcp` is in `isPublicPath` so the route can 401 rather than 302 | `lib/route-access.ts` |

There are **no** `.well-known` routes anywhere in the repo, no OAuth client /
token / consent models in `prisma/schema.prisma`, and no authorization-server
endpoints. The only `oauth` references in the codebase are Google *login* for
the web app in `auth.ts` — Compass as an OAuth **client**, not a provider.

Note that this is not a spec violation: *"Authorization is **OPTIONAL** for MCP
implementations."* Compass simply has not opted into the authorization layer.
The cost is that the bare `WWW-Authenticate: Bearer` carries no
`resource_metadata` parameter, so a client has nothing to discover, and
connecting requires a human to generate a key in Settings and paste it into a
client config (the `mcp-remote` recipe in `docs/content/09-mcp-api.md`).

## Goal

A user pastes `https://compass.rbcodelabs.com/api/mcp` into Claude, ChatGPT,
Cursor, or VS Code, is bounced to a Compass login + consent screen, approves,
and is connected. No key generation, no config file, no copy-paste secret.

## Architecture decision — Compass is its own authorization server

1. **Delegate to Google.** Rejected, and the evidence is concrete. Fetching
   `https://accounts.google.com/.well-known/openid-configuration` shows no
   `registration_endpoint`, no `client_id_metadata_document_supported`, no
   `"none"` in `token_endpoint_auth_methods_supported`, and no RFC 8707
   support. So: no client-registration path for any MCP client, and Google will
   never mint a token whose audience is `https://compass.rbcodelabs.com/api/mcp`.
   Accepting one anyway would violate the spec's hardest MUST — *"MCP servers
   MUST NOT accept any tokens that were not explicitly issued for the MCP
   server."* It would also strand Resend magic-link users entirely.
2. **Buy a hosted AS** (Auth0 / WorkOS / Stytch / Scalekit / Entra ID — all
   speak RFC 8707 + DCR or CIMD). Viable. But it splits identity: Compass
   already owns `User`, `OrganizationMember`, and `WorkspaceMember`, and every
   MCP gate resolves against those rows. Adds a vendor, a bill, and a sync
   problem to avoid roughly 600 lines.
3. **Be our own AS on the same origin.** Chosen. Issuer, resource server, and
   identity provider are all `compass.rbcodelabs.com`. Tokens map 1:1 onto the
   existing `McpActor`, so **`lib/mcp-authz.ts` and every tool gate is
   untouched**. Google remains an upstream *identity* source via NextAuth, not
   the OAuth AS for this resource — which is exactly the architecture the spec
   recommends.

## Where NextAuth fits — and where it does not

NextAuth/Auth.js v5 is an OAuth **relying party** and session manager. It has
no provider mode: it does not implement `/authorize`, `/token`, `/register`, or
`/revoke`, and it cannot mint access tokens for third parties. It is not the
authorization server and cannot be made into one.

It does three real jobs, and they are the three jobs that are otherwise most
annoying to build:

1. **Authenticating the human at `/oauth/authorize`.** The authorize endpoint
   is an ordinary Next.js route whose first question is "who is this?" That is
   `const session = await auth()` from `@/auth`. Unauthenticated callers fall
   through to the existing `/login` page, which already provides Resend
   magic-link, Google SSO, and the dev Credentials shortcut. **No new login UI
   is needed.**
2. **Producing the `userId` the token binds to.** `session.user.id` is already
   populated by the `session` callback in `auth.config.ts` (database strategy,
   Prisma adapter) and by the `jwt`/`session` pair in dev. That id is exactly
   what `validateMcpAuth` returns today and exactly what `McpActor.userId`
   consumes. An OAuth access token becomes a second way to name an actor the
   system already understands.
3. **Session reuse across reconnects.** A user already signed into Compass in
   that browser re-approves a client in one click, because the Auth.js session
   cookie is already present.

Explicitly **not** reusable: the `Account` table. It stores tokens *we received
from* Google — the opposite direction from tokens *we issue*. Do not overload
it.

### Two blockers in the current NextAuth wiring

Both are small, both are required, and neither is about OAuth:

- **`proxy.ts` drops the return URL.** It redirects to a bare `/login`:
  `return Response.redirect(new URL("/login", req.nextUrl))` — the original
  path and query string are discarded. An OAuth authorize request carries
  `client_id`, `redirect_uri`, `state`, `code_challenge`, `resource`, and
  `scope` in the query string. Losing it breaks the flow for every
  not-currently-signed-in user, which is the common case (MCP clients open a
  fresh browser). Must preserve the original URL as `callbackUrl`.
- **`/login` hardcodes its destination.** `app/login/page.tsx` passes
  `callbackUrl: "/dashboard"` (Google) and `redirectTo: "/dashboard"`
  (magic link). It must read a `callbackUrl` search param and
  validate it as a same-origin *relative path* before using it — an
  unvalidated passthrough here is an open redirect.

## Client registration — DCR only

This is the part that changed recently and is easy to get wrong.

| Revision | DCR (RFC 7591) | CIMD (`draft-ietf-oauth-client-id-metadata-document-00`) |
|---|---|---|
| 2025-06-18 | **SHOULD** support | not in spec |
| 2025-11-25 | **MAY** support | **SHOULD** support |
| **2026-07-28 (current)** | **MAY**, explicitly **deprecated** | **SHOULD** support |

The 2026-07-28 changelog: *"The OAuth 2.0 Dynamic Client Registration Protocol
is deprecated as a client registration mechanism. It is replaced by Client ID
Metadata Documents."* Deprecated features stay ≥12 months before removal.

**But shipping CIMD alone does not work today.** Per Anthropic's own connector
docs, Claude selects the CIMD path only when the AS metadata advertises **both**
`"client_id_metadata_document_supported": true` **and** `"none"` in
`token_endpoint_auth_methods_supported` — *"If either is missing, Claude falls
back to DCR."* Meanwhile `mcp-remote` cannot perform the CIMD flow at all even
when advertised (geelen/mcp-remote#224), Cursor is reportedly DCR-first, and
Claude Code has had repeated CIMD regressions.

**The Geode broker settles this: DCR is required.** It is DCR-only —
`OAuthMcpRegistry.ts` hard-fails with *"authorization server does not support
Dynamic Client Registration and no clientId was supplied"* when
`registration_endpoint` is absent, and there is no CIMD code path in
`OAuthMcpFlow.ts`. So `registration_endpoint` is a **blocking** requirement for
the primary consumer, not a compatibility nicety.

**Decision: DCR only (decision 5).** Expose `registration_endpoint`; do not
advertise `client_id_metadata_document_supported`, and do not build CIMD.

The reasoning is that CIMD currently buys nothing. Every client Compass cares
about falls back to DCR when CIMD is unadvertised, so DCR alone is complete
coverage — and maintaining two registration paths costs real complexity for a
mechanism no shipping client requires. `@modelcontextprotocol/sdk@1.26.0` has
**no server-side CIMD support** either (`client_id_metadata_document` appears
only under `client/`), so it would be hand-written from scratch.

Revisit when either becomes true: a client Compass wants to support requires
CIMD, or DCR's removal date firms up (deprecated MCP features get ≥12 months,
so this is not near-term). The migration is additive — add
`client_id_metadata_document_supported` to the metadata and a
`clientIdMetadataUrl` column, keeping DCR alongside.

One thing to get right even though we are not building CIMD: do **not** emit
`"registration_endpoint": null` for anything unsupported — Claude Code
Zod-fails on a null here (anthropics/claude-code#38102). Omit unsupported keys
entirely rather than nulling them.

## Client profile — the Geode Agent Threads broker

Geode already ships a complete OAuth 2.1 + PKCE broker for OAuth-gated remote
MCP servers. Compass supplying the authorization side is the other half of a
one-click setup. Because the broker is *already written*, its actual behavior —
not the spec's ideal — defines what Compass must accept.

Shape: the broker is a **per-user public client running on the user's own
machine**, with a loopback redirect. It is not a multi-tenant proxy, so the
confused-deputy hazard that applies to hosted MCP proxies does not apply here.
`OAuthMcpProxy.ts` then presents the remote server to the local harness as an
ordinary `http` MCP server behind an `X-Capability-Token`, injecting
`Authorization: Bearer <access_token>` on the way out — so on this path Claude's
own DCR/CIMD quirks never come into play. The broker is the only OAuth client.

Verified behavior, read from source:

| Aspect | What the broker does | What Compass must therefore do |
|---|---|---|
| Discovery | `discoverOAuthServerInfo(entry.authorizationServerUrl ?? entry.url)` — falls back to the **resource URL**, so the SDK performs RFC 9728 path insertion | **Must** serve PRM at `/.well-known/oauth-protected-resource/api/mcp` — the root path alone is not enough |
| Registration | DCR only, via the SDK's `registerClient` | **Must** expose `registration_endpoint` |
| Client metadata | `client_name: "Agent Threads"`, `token_endpoint_auth_method: "none"`, `grant_types: ["authorization_code","refresh_token"]`, `response_types: ["code"]` | **Must** accept public clients (`"none"`) |
| Redirect URI at DCR | `http://127.0.0.1/callback` — **portless** | See below |
| Redirect URI at authorize | `http://127.0.0.1:<ephemeral>/callback` — a **different port every time** | **Must** match loopback port-agnostically |
| PKCE | Always `S256`, verifier generated per flow | Advertise `code_challenge_methods_supported` |
| `state` | 16 random bytes, validated on callback | — |
| `resource` (RFC 8707) | **Never sent**, at authorize or token exchange | **Must not** require it — default the audience |
| `iss` (RFC 9207) | Ignored on the callback | Harmless to emit |
| Refresh | `refreshAuthorization` with `client_id` only; proxy auto-refreshes on upstream 401 | **Must** issue a refresh token for the auth-code grant |
| Revocation | RFC 7009 POST with `token`, `token_type_hint`, `client_id`, no secret | `/revoke` must accept a public client |
| Consent timeout | 5 minutes | Comfortable |

Three of these are load-bearing enough to restate:

1. **Port-agnostic loopback matching is blocking, not optional.** The broker
   registers a portless `http://127.0.0.1/callback` and then authorizes with
   whatever ephemeral port its callback server binds. The code comments name
   the dependency explicitly — RFC 8252 §7.3, *"the authorization server MUST
   allow any port to be specified at the time of the request"* — and flag that
   *"an AS that instead enforces exact redirect_uri port matching will reject
   the later authorize() callback."* Compass must compare scheme + host + path
   and ignore the port for `127.0.0.1` and `localhost`. Everything else stays
   exact string matching.
2. **`resource` must be optional.** The broker never sends it, and neither does
   `mcp-remote`. The spec says clients MUST send it, but a Compass that
   *rejects* on its absence breaks its own primary consumer on day one. Rule:
   when `resource` is absent, default the token's audience to Compass's
   canonical MCP URI; when present and different, reject. Compass is the only
   resource this AS serves, so the default is unambiguous.

   Worth being precise about how little this matters in practice: omitting
   `resource` has been observed working against other MCP servers, and that is
   the expected result, not luck. A single-tenant MCP server that is its own AS
   serves exactly one resource, so `resource` is redundant — there is nothing
   for the AS to disambiguate. It only becomes load-bearing when a resource
   server fronts a *separate* AS that issues tokens for several resources and
   therefore needs to be told which audience to mint (the hosted-AS pattern:
   Auth0, WorkOS, Entra fronting multiple MCP servers). Compass is emphatically
   not that. So this is a latent conformance gap on the Geode side, not an
   observed bug, and not worth scheduling.
3. **Issue refresh tokens unconditionally for the authorization-code grant.**
   The broker requests the `refresh_token` grant at DCR but does **not** append
   `offline_access` to its scope string, and its proxy depends on refresh to
   recover from a 401. Gating refresh-token issuance on an `offline_access`
   scope — which is what Claude's behavior would suggest — would leave every
   Geode user re-authorizing by hand on token expiry.

### Consequence: one registered client per Geode install

The broker would short-circuit DCR if `entry.clientId` were set, but we are
deliberately not doing that (decision 4). So every Geode install registers its
own dynamic client, all carrying `client_name: "Agent Threads"`, and Compass
accumulates one row per install. That is the accepted cost of having a single
registration path. It makes two things load-bearing rather than optional: the
`/register` rate limit and TTL pruning, and the consent screen's "unverified"
treatment — since a user cannot distinguish their own Geode's client from
anyone else's by name alone, only by redirect host.

## Client compatibility — Geode first, everyone else not foreclosed

Geode is the first consumer, not the only target. The test for every phase-1
decision is therefore: does it *also* work for a client connecting directly?
Each Geode-driven choice below is strictly more permissive than the spec
minimum, so none of them narrows the door.

| Phase-1 decision | Driven by | Effect on other clients |
|---|---|---|
| Expose `registration_endpoint` (DCR) | Geode (blocking) | **Universal win.** Claude falls back to DCR when CIMD isn't advertised; Cursor is DCR-first; VS Code does DCR or a built-in static client; `mcp-remote` needs DCR. DCR alone covers every client shipping today |
| Port-agnostic loopback matching | Geode (blocking) | Also required by Claude Code (`http://localhost/callback` + `http://127.0.0.1/callback`, ephemeral port) |
| `resource` optional, audience defaulted | Geode, `mcp-remote` | Strictly more permissive. Clients that *do* send it still get exact audience binding |
| Refresh token issued unconditionally | Geode | Claude appends `offline_access` when advertised and gets a refresh token either way. No conflict |
| PRM at path-inserted **and** root URL | Geode discovers from the resource URL | Matches the spec's client fallback order — path-inserted, then root |
| Hand-rolled 401/403 challenge with `scope` | Claude (consent breadth) | Not needed by Geode, included anyway — without it Claude requests every scope in `scopes_supported` |
| Both `oauth-authorization-server` and `openid-configuration` | Spec (clients MUST support both) | Universal |

Nothing here is a one-way door. The two deliberate omissions are both additive
later: **CIMD** is unscheduled (decision 5 — every client falls back to DCR, so
it buys nothing today), and **RFC 9207 `iss`** sits in phase 2 (clients proceed
normally when an AS neither advertises nor sends it, so deferring is safe; it is
also only a few lines, so fold it into phase 1 if convenient).

Two failure modes are invisible to a Geode-only test and must be checked
separately before claiming broad support:

- **Consent breadth.** Only surfaces with a client that honors the challenge's
  `scope` parameter. Keep `scopes_supported` short and verify Claude's consent
  screen lists what you expect, not everything.
- **The 10 s discovery/registration/token timeout** Claude enforces. A cold
  Vercel function plus a DSQL IAM-signed connection can approach it. Geode's
  5-minute consent window hides this entirely. Keep the `.well-known` documents
  static and DB-free, and measure `/token` on a cold preview.

## Protocol surface

### Resource server

`mcp-handler@1.1.0` (already a dependency) supplies most of this, with three
sharp edges worth knowing before wiring it:

- **`withMcpAuth`'s `required` option defaults to `false`.** If `verifyToken`
  returns `undefined` the request is passed through **unauthenticated**. Pass
  `{ required: true }` explicitly.
- **`resourceMetadataPath` defaults to the root path** — it does no RFC 9728
  path insertion. For an endpoint at `/api/mcp` pass
  `"/.well-known/oauth-protected-resource/api/mcp"`.
- **Its 401 header never emits the `scope` parameter**, even when
  `requiredScopes` is set. Per Anthropic's docs, a missing `scope` means Claude
  requests everything in `scopes_supported` — i.e. maximal consent every time.

Given the last two, **hand-roll the challenge header** (it is five lines) so we
can emit `scope` and distinguish the two cases the spec calls for:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://compass.rbcodelabs.com/.well-known/oauth-protected-resource/api/mcp",
                         scope="mcp:read"
```

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="mcp:write",
                         resource_metadata="https://compass.rbcodelabs.com/.well-known/oauth-protected-resource/api/mcp"
```

Scope failures are **403**, not 401. Claude ignores `WWW-Authenticate` on a
`200`, so the MCP route must genuinely return 401/403.

For the metadata document itself, `protectedResourceHandler` emits only
`{ resource, authorization_servers }` and does **not** forward
`additionalMetadata` — so call `generateProtectedResourceMetadata` directly to
include `scopes_supported` / `resource_name` / `bearer_methods_supported`:

```json
{
  "resource": "https://compass.rbcodelabs.com/api/mcp",
  "authorization_servers": ["https://compass.rbcodelabs.com"],
  "scopes_supported": ["mcp:read", "mcp:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Compass"
}
```

`authorization_servers` is a spec-level **MUST** for MCP servers (RFC 9728
itself marks only `resource` required). **Claude uses only the first entry and
does not fall back**, so order matters. `resource` must be the canonical URI —
HTTPS, no fragment, no trailing slash — and must match the MCP URL *exactly as
the user types it*.

Serve the document at both the path-inserted URL and the bare root path (the
spec's client fallback order is path-inserted → root), plus
`metadataCorsOptionsRequestHandler()` for browser clients.

Compass's local `withMcpAuth` wrapper (the local `withMcpAuth` in `app/api/mcp/route.ts`) becomes the
token-verification callback; `runWithMcpActor` still wraps the handler,
unchanged.

**Routing note:** Next 16.2.6 only filters `_`-prefixed path segments during
route discovery (`ignorePartFilter: (part) => part.startsWith('_')` in
`dist/build/route-discovery.js`), so `app/.well-known/**/route.ts` is
discovered normally. Worth a five-minute smoke test anyway; fallback is a
`next.config.ts` rewrite.

### Authorization server — net new

The MCP SDK ships `mcpAuthRouter`, `OAuthServerProvider`, and
authorize/token/register/revoke handlers — but every one is typed against
`express.RequestHandler` (`provider.d.ts` imports `Response` from `'express'`),
so none can mount in the App Router. Reuse the **interfaces and zod schemas**
from `@modelcontextprotocol/sdk/shared/auth.js` (`OAuthMetadataSchema`,
`OAuthProtectedResourceMetadataSchema`, `OAuthClientInformationFull`,
`OAuthTokens`) and `server/auth/types.js` (`AuthInfo` is a plain interface) to
validate our own responses; reimplement the handlers as Next route handlers.
Model the internal contract on `OAuthServerProvider` even though we can't mount
its router.

Explicitly avoid `ProxyOAuthServerProvider` — it sets
`skipLocalPkceValidation = true`, stubs `challengeForAuthorizationCode`, and
gives no per-client consent machinery. It is the shape most likely to drift
into the confused-deputy vulnerability.

| Route | Spec | Notes |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Primary probe for a path-less issuer |
| `GET /.well-known/openid-configuration` | OIDC Discovery | Clients **MUST** support both; serve both |
| `GET /oauth/authorize` | OAuth 2.1 | `auth()` gate → consent → issue code |
| `POST /api/oauth/token` | OAuth 2.1 | `authorization_code` + `refresh_token` |
| `POST /api/oauth/register` | RFC 7591 | DCR, for compatibility |
| `POST /api/oauth/revoke` | RFC 7009 | Revoke access or refresh token |

```json
{
  "issuer": "https://compass.rbcodelabs.com",
  "authorization_endpoint": "https://compass.rbcodelabs.com/oauth/authorize",
  "token_endpoint": "https://compass.rbcodelabs.com/api/oauth/token",
  "registration_endpoint": "https://compass.rbcodelabs.com/api/oauth/register",
  "revocation_endpoint": "https://compass.rbcodelabs.com/api/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none"],
  "authorization_response_iss_parameter_supported": true,
  "scopes_supported": ["mcp:read", "mcp:write", "offline_access"]
}
```

`client_id_metadata_document_supported` is deliberately **absent**, not `false`
— per decision 5 we do not implement CIMD, and advertising it would make Claude
attempt a flow that does not exist rather than falling back to DCR. Omit
unsupported keys; never null them.

Field-by-field rationale for the non-obvious entries:

- `code_challenge_methods_supported` is **load-bearing**: *"If
  `code_challenge_methods_supported` is absent, the authorization server does
  not support PKCE and MCP clients MUST refuse to proceed."* Omitting it breaks
  every client.
- `"none"` in `token_endpoint_auth_methods_supported` is correct because every
  client here is public — Geode registers with `token_endpoint_auth_method:
  "none"`, and loopback clients cannot hold a secret. (It also happens to be
  one of the two flags Claude's CIMD path requires, but we are not advertising
  CIMD, so that is incidental.)
- `authorization_response_iss_parameter_supported` pairs with RFC 9207 `iss`,
  **new in 2026-07-28**: record the validated issuer alongside the PKCE
  verifier, and emit `iss` on the authorization response. The spec flags this
  will go SHOULD → MUST in a future revision, so build it now.
- `offline_access` in the **AS** metadata is what makes Claude request a
  refresh token. (The spec's "SHOULD NOT advertise `offline_access`" guidance
  applies to the *PRM* document, a different file — no conflict.)

`issuer` should come from the existing `trustedCompassBaseUrl()` in
`lib/compass-url.ts` (currently module-private; export it). It already resolves
prod vs. preview correctly and uses `VERCEL_BRANCH_URL` for previews, which is
stable per branch — so preview deploys can support OAuth per-branch rather than
being excluded. Clients **MUST** validate that the returned `issuer` byte-equals
the issuer they used to build the URL, so this value cannot drift.

## Data model

Four new Prisma models. Aurora DSQL constraints apply throughout: UUID PKs via
`gen_random_uuid()`, no `@updatedAt`, no FK constraints (`relationMode =
"prisma"` is already set), `ASYNC` index creation, one DDL per transaction.
Store `redirectUris` and `grantTypes` as `Json` columns rather than Postgres
arrays — the schema already uses `Json` in several places and it sidesteps an
array-type question on DSQL.

- **`OAuthClient`** — `clientId`, `clientSecretHash?` (null for public clients,
  which is every client today), `clientName`, `redirectUris Json`,
  `grantTypes Json`, `scope`, `tokenEndpointAuthMethod`, `logoUri?`,
  `clientUri?`, `softwareId?`, `registrationAccessTokenHash?`, `createdAt`,
  `lastUsedAt`. No `registrationMode` discriminator and no
  `clientIdMetadataUrl` — DCR is the only path (decision 5), and adding those
  columns later is a trivial additive migration if CIMD ever lands. Expect one
  row per Geode install; `lastUsedAt` is what TTL pruning keys off.
- **`OAuthAuthorizationCode`** — `codeHash` (unique), `clientId`, `userId`,
  `redirectUri`, `codeChallenge`, `codeChallengeMethod`, `scope`, `resource`,
  `expiresAt` (60 s), `consumedAt?`.
- **`OAuthToken`** — `tokenHash` (unique), `type` (`ACCESS` | `REFRESH`),
  `clientId`, `userId`, `scope`, `resource`, `scopeWorkspaceId?`, `expiresAt`,
  `revokedAt?`, `familyId`, `parentTokenId?`, `createdAt`, `lastUsedAt`.
- **`OAuthConsent`** — `userId`, `clientId`, `scope`, `grantedAt`. Lets repeat
  authorizations skip the consent screen.

### Token format

Use **opaque random tokens, SHA-256 hashed at rest** — `cmp_oat_<32 hex>` /
`cmp_ort_<32 hex>`. Mirrors both existing precedents (`ApiKey.keyHash`,
`PortalSession.tokenHash`), gives instant revocation, and costs nothing extra:
the MCP route already does one DB read per request to validate `cmp_…` keys.
A signed JWT via `jose` (already a dependency) would avoid that read but needs
a revocation denylist — not worth it at this scale.

### Token → actor mapping

`validateMcpAuth` gains one branch, and nothing downstream changes:

```ts
if (token.startsWith("cmp_oat_")) {
  const t = await prisma.oAuthToken.findFirst({
    where: { tokenHash: sha256(token), type: "ACCESS", revokedAt: null,
             expiresAt: { gt: new Date() }, resource: MCP_RESOURCE_URL },
    select: { userId: true, scope: true, scopeWorkspaceId: true },
  })
  if (!t) return { valid: false }
  return { valid: true, userId: t.userId, purpose: "USER",
           scopeWorkspaceId: t.scopeWorkspaceId, scopes: t.scope.split(" ") }
}
```

The `resource: MCP_RESOURCE_URL` predicate is where the spec's audience MUST
lands — *"MCP servers MUST only accept tokens specifically intended for
themselves and MUST reject tokens that do not include them in the audience
claim."*

This is the crux of the design: **an OAuth token is just another way to produce
a `McpActor`.** Every gate, every membership assertion, and the "not found
or access denied" non-disclosure behavior carry over untouched.

## Scopes

Start with `mcp:read` and `mcp:write` (plus `offline_access`). This requires a
new `TOOL_SCOPES` map beside `TOOL_GATES` in `lib/mcp-tool-gates.ts`,
classifying every registered tool (145 today) — the gates are currently membership-based only and
encode no read/write distinction. Extend the existing completeness test
(`__tests__/mcp-tool-gates.test.ts`) to assert every registered tool has a
scope entry, so the map cannot drift. `RESEARCH_TOOL_ALLOWLIST` is the
precedent for a scope-limited token class.

Keep `scopes_supported` deliberately short. Clients that see no `scope`
parameter in the challenge request **everything** listed there, so each extra
advertised scope is consent surface a user will be asked to grant by default.

Optionally add a workspace picker on the consent screen, writing
`scopeWorkspaceId` onto the token and reusing `assertActorWorkspaceScope`.

## Security requirements

- **PKCE `S256` mandatory.** Reject `plain`; reject a missing `code_challenge`.
  Advertise `code_challenge_methods_supported` or clients must refuse to
  proceed.
- **Exact `redirect_uri` string matching** against registered values — no
  wildcards, no prefix matching — **plus a port-agnostic loopback exception**
  (RFC 8252 §7.3). Required by the Geode broker (registers portless
  `http://127.0.0.1/callback`, authorizes on an ephemeral port) and by Claude
  Code, which declares both `http://localhost/callback` and
  `http://127.0.0.1/callback`. Hosted Claude surfaces use
  `https://claude.ai/api/mcp/auth_callback`. All must work. Ignore the port
  **only** for the two loopback hosts; never for any other host.
- **Resource indicators (RFC 8707), leniently.** Accept `resource` at both
  authorize and token and bind the token's audience to
  `https://compass.rbcodelabs.com/api/mcp`. **Absent → default to that
  audience; present and different → reject.** Do not make presence a
  precondition: the Geode broker and `mcp-remote` both omit it. The resource
  server still enforces the audience on every request, so the security
  property is preserved. Never accept a token in a URI query string.
- **RFC 9207 `iss`** on the authorization response, with
  `authorization_response_iss_parameter_supported: true`.
- **Single-use codes, 60 s TTL**, consumed atomically. On DSQL use a
  conditional `updateMany({ where: { codeHash, consumedAt: null } })` and check
  the affected count — never read-then-write.
- **Refresh token rotation with reuse detection.** Replay of a rotated refresh
  token revokes the whole `familyId`.
- **Rate-limit and prune `/register`.** DCR is unauthenticated by design; cap
  per-IP and garbage-collect clients that never completed a flow.
- **Consent screen hardening.** Show `client_name`, the `redirect_uri` host,
  the requested scopes, and **an explicit list of the orgs and workspaces being
  granted** (per decision 1 the grant spans every membership the user has, which
  is broader than people assume). Visibly mark unverified dynamic clients —
  anyone can register a client named "Compass Official", and since we run open
  DCR with no static clients, *every* client is dynamic and unverified; the
  redirect host is the only signal a user has that cannot be forged. CSRF
  protection, `X-Frame-Options: DENY` /
  `frame-ancestors 'none'`, `__Host-`-prefixed `Secure`/`HttpOnly`/
  `SameSite=Lax` signed consent cookie bound to the specific `client_id`, and
  do not set the state cookie until after approval.
- **CIMD validation:** `client_id` must be HTTPS with a non-root path, the
  fetched document's `client_id` must equal the URL exactly, `redirect_uris`
  must validate against the document, and the fetch needs a timeout + size cap
  (it is an outbound request to an attacker-chosen URL — SSRF surface).
- **Validate `callbackUrl` on `/login`** as a same-origin relative path.
- **OAuth tokens must never take the `RESEARCH` path.** Pin `purpose: "USER"`.
- CORS on both `.well-known` documents.
- Rotate-and-store discipline per `CLAUDE.md` for any new signing secret.

### Latency risk — Aurora DSQL cold starts vs. Claude's timeouts

Claude enforces **10 s** on discovery, registration, and token requests (30 s
on refresh). A cold Vercel function plus a DSQL IAM-signed connection can
approach that. The `.well-known` documents must therefore be **static and
DB-free** (they are pure config — no query needed), and `/token` should be the
leanest possible path. Worth measuring on a preview deploy before launch.

## Routing changes

Add to `isPublicPath` in `lib/route-access.ts`:
`/.well-known/`, `/api/oauth/token`, `/api/oauth/register`, `/api/oauth/revoke`.

Deliberately **do not** make `/oauth/authorize` public — it must hit the
middleware auth redirect (with the URL-preserving fix above) so unauthenticated
users are sent to `/login` and returned afterward.

## Dependency versions

Compass pins `@modelcontextprotocol/sdk@1.26.0` (latest 1.30.0) and
`mcp-handler@^1.1.0` (latest 2.1.1). Neither upgrade is a prerequisite: we use
the SDK only for its framework-neutral zod schemas and `AuthInfo` type, all of
which 1.26.0 already has. Do check 2.x of `mcp-handler` before hand-rolling
around the `scope`-parameter and path-insertion gaps — they may already be
closed.

For reference, Geode's broker is on `@modelcontextprotocol/sdk@^1.29.0`. The
two sides do not need to match; they only share the wire protocol.

## Phasing

**Phase 1 — a general OAuth AS, with Geode as the acceptance test.** PRM at the
path-inserted and root URLs, AS metadata at both well-known paths, **DCR**,
authorize + consent, token endpoint with PKCE and lenient `resource`, refresh
tokens issued by default, RFC 7009 revocation for public clients, opaque access
tokens, `mcp:read`/`mcp:write`, the `validateMcpAuth` branch, and the two
NextAuth fixes. Nothing in this set is Geode-specific (see *Client
compatibility*) — Geode is simply the first client to prove it end to end, and
a direct Claude connection should be verified in the same PR. Metadata without
a working AS is worse than no metadata.

**Phase 2 — lifecycle.** Refresh rotation with reuse detection, a "Connected
apps" panel in Settings (client, scopes, last used, revoke) alongside the
existing API-keys panel, `/register` rate limiting and TTL pruning if the open
registration surface starts attracting noise, and RFC 9207 `iss`.

**Not scheduled.** CIMD (decision 5 — revisit when a client requires it or
DCR's removal date firms up), workspace-scoped consent (decision 1 — the
`assertActorWorkspaceScope` primitive is already there if we want it), a static
or verified-client allowlist (decision 4), and an authorization audit log.

Static `cmp_…` API keys stay supported indefinitely for server-to-server use;
`MCP_API_KEY` service-account behavior is unchanged.

## Verification plan

- **Unit:** PKCE verification, code single-use under concurrency, redirect_uri
  matching (exact + loopback port-agnostic), refresh rotation + reuse
  detection, audience rejection, CIMD document validation, `TOOL_SCOPES`
  completeness.
- **Integration (highest value):** a Node probe script walking the real chain —
  `POST /api/mcp` with no token → assert the `WWW-Authenticate`
  `resource_metadata` and `scope` values → fetch PRM at both paths → fetch AS
  metadata at both well-known URLs and assert `issuer` byte-matches → register
  (both CIMD and DCR) → authorize with a seeded session cookie → assert `iss`
  on the response → `POST /token` → `initialize` against `/api/mcp` → assert a
  foreign-`resource` token is rejected. This is exactly what a real client
  does.
- **Manual — per-client acceptance matrix.** Phase 1 is not done until row 1
  and row 2 both pass; rows 3–4 are strong signals that the AS is genuinely
  general rather than Geode-shaped. Screenshots of each consent screen per the
  `pr-checklist` visual-verification steps.

  | # | Client | Proves |
  |---|---|---|
  | 1 | **Geode / Agent Threads** — `mcp_register_server` with `type: "oauth"`, consent in the Web Viewer, call a tool through `OAuthMcpProxy`, force a 401 to exercise auto-refresh, then revoke from Settings | DCR, loopback port-agnosticism, absent `resource`, refresh, RFC 7009 |
  | 2 | **Claude** (claude.ai or Desktop connector) against a preview deploy | DCR fallback when CIMD is unadvertised, `https://claude.ai/api/mcp/auth_callback` redirect, consent breadth from the challenge's `scope`, and the 10 s timeout budget on a cold function |
  | 3 | **`mcp-remote`** | The lowest-common-denominator DCR path |
  | 4 | **Cursor or VS Code** | A second independent DCR implementation |
- **Cross-repo regression:** re-authorize twice in a row from the same Geode
  install. The second authorization binds a different ephemeral port — if
  port-agnostic loopback matching is wrong, this is where it fails, and only
  here.
- **Migration:** new tables via `/api/admin/migrate` using the `dsql-migrate`
  skill; `ASYNC` indexes; one DDL per transaction.

## Rough sizing

| Work | Estimate |
|---|---|
| Prisma models + DSQL migration | 0.5 d |
| AS endpoints (authorize, token, register, revoke, ×2 metadata) | 1.5 d |
| Consent screen (incl. org/workspace enumeration) + `/login` `callbackUrl` + `proxy.ts` fix | 0.5 d |
| Resource-server wiring + `validateMcpAuth` branch + `TOOL_SCOPES` | 0.5 d |
| Tests (unit + probe script) | 1 d |
| Docs (`09-mcp-api.md`) + ADR | 0.5 d |

≈ **4.5 days** for Phase 1, assuming no surprises from DSQL or `.well-known`
routing. The 2026-09-12 decisions removed CIMD (0.5 d) and the static-client
coordination from this scope; they did not change anything else, because every
other decision confirmed the cheaper option that was already specced.

## Decisions (2026-09-12)

Resolved with Rick. These are settled, not open.

1. **No workspace picker on consent.** An OAuth token carries the same reach a
   per-user `cmp_…` key already has — every workspace the user is a member of,
   across every org. This matches the existing key model rather than inventing
   a second scoping concept, and `assertActorWorkspaceScope` already exists if
   we want to narrow it later (existing tokens would carry
   `scopeWorkspaceId: null` = all memberships, so it stays additive).
   **In exchange, the consent screen must enumerate the orgs and workspaces
   being granted** — the grant spans organizations, which is broader than
   people will assume, and naming them is nearly free.
2. **DCR stays open.** Gating it is not actually available: registration
   happens before any user is involved (`OAuthMcpRegistry` calls
   `registerClient()` and only then `authorize()`), so an auth requirement
   would break the primary consumer. Rate-limit per IP and TTL-expire clients
   that never complete an authorization; monitor and revisit only if abuse
   shows up. The defense against a client registering itself as "Compass
   Official" is the consent screen showing the **redirect host**, which is the
   one thing an attacker cannot forge.
3. **Previews are in scope.** The Vercel plan limitation that was blocking
   preview deployments is fixed. Use `trustedCompassBaseUrl()` as-is — it
   already resolves `VERCEL_BRANCH_URL`, which is stable per branch (unlike
   `VERCEL_URL`, which is per deployment), so `issuer` stays byte-stable across
   pushes, which is what clients validate. Previews run the `compass_preview`
   schema, so registered clients don't leak between environments; expect to
   redo DCR per branch. This matters more than usual here: the feature is
   entirely a handshake with external software, and production is the wrong
   place to discover that redirect-URI matching is too strict.

   **Caveat found while probing a live preview (2026-09-12):** Vercel
   Deployment Protection sits in front of preview deployments and intercepts
   *every* request before it reaches Compass. An unauthenticated
   `POST /api/mcp` against a preview returns Vercel's own
   `401 {"error":{"code":"401","message":"Protected deployment"}}` with
   `vercel_auth_enabled: true`, and `/.well-known/*` 302s to
   `vercel.com/sso-api` — none of it is Compass's code running. So a preview is
   **not** usable for OAuth testing as-is: an MCP client would discover Vercel's
   SSO redirect instead of Compass's authorization server. The repo already
   carries `VERCEL_AUTOMATION_BYPASS_SECRET` machinery
   (`playwright.config.ts`, ADR 0008) which solves this for callers we control,
   but neither the Geode broker nor Claude can attach
   `x-vercel-protection-bypass` to its discovery/token requests. **Preview
   OAuth testing therefore requires deployment protection disabled on that
   preview**, not just a bypass secret. Decide this before relying on previews
   as the test bed.
4. **No static Agent Threads client.** DCR is the one registration path. A
   pre-seeded verified client would save a single HTTP round trip and improve
   some consent wording, but it removes none of the hard requirements — Geode
   still binds ephemeral ports, so port-agnostic loopback matching is needed
   either way — and it adds cross-repo coupling on a shared constant. Not worth
   maintaining two paths.
5. **CIMD is not scheduled.** Deprecated-but-supported DCR covers every client
   shipping today. Revisit only when a client Compass cares about actually
   requires CIMD, or when DCR's removal timeline becomes concrete (deprecated
   MCP features get ≥12 months).

## References

- MCP [2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
  [AS discovery](https://modelcontextprotocol.io/specification/draft/basic/authorization/authorization-server-discovery),
  [client registration](https://modelcontextprotocol.io/specification/draft/basic/authorization/client-registration),
  [security considerations](https://modelcontextprotocol.io/specification/draft/basic/authorization/security-considerations)
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) (Protected Resource Metadata)
- [Anthropic — connector authentication](https://claude.com/docs/connectors/building/authentication)
- geelen/mcp-remote#224 (no CIMD support); anthropics/claude-code#38102, #37747, #36861 (CIMD regressions)
