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
| Per-tool policy | Fail-closed gate map; all 108 registered tools must have an entry | `lib/mcp-tool-gates.ts` |
| Key issuance | `createApiKey` server action, Settings UI, shown once | `app/[orgSlug]/[workspaceSlug]/settings/actions.ts:359` |
| 401 response | `new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })` | `app/api/mcp/route.ts:2919` |
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
   existing `McpActor`, so **`lib/mcp-authz.ts` and all 108 tool gates are
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
  `callbackUrl: "/dashboard"` (line 108, Google) and `redirectTo: "/dashboard"`
  (line 178, magic link). It must read a `callbackUrl` search param and
  validate it as a same-origin *relative path* before using it — an
  unvalidated passthrough here is an open redirect.

## Client registration — CIMD **and** DCR

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
the primary consumer, not a compatibility nicety. CIMD is additive — ship it for
direct Claude.ai / Cursor connections and for forward-compatibility, but it
cannot replace DCR here.

**Decision: implement both.** Advertise CIMD (spec-preferred, forward-looking)
*and* expose `registration_endpoint` (what deployed clients actually use).
Under CIMD the `client_id` **is** an HTTPS URL with a path component; the AS
**MUST** verify the fetched document's `client_id` matches that URL exactly and
**MUST** validate `redirect_uris` against the document.

Note `@modelcontextprotocol/sdk@1.26.0` has **no server-side CIMD support** —
`client_id_metadata_document` appears only under `client/`. CIMD validation is
hand-written.

Do **not** emit `"registration_endpoint": null` when unsupported — Claude Code
Zod-fails on it (anthropics/claude-code#38102). Omit the key entirely.

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
   resource this AS serves, so the default is unambiguous. (Adding `resource`
   to the broker is a good follow-up on the Geode side — it just must not be a
   precondition.)
3. **Issue refresh tokens unconditionally for the authorization-code grant.**
   The broker requests the `refresh_token` grant at DCR but does **not** append
   `offline_access` to its scope string, and its proxy depends on refresh to
   recover from a 401. Gating refresh-token issuance on an `offline_access`
   scope — which is what Claude's behavior would suggest — would leave every
   Geode user re-authorizing by hand on token expiry.

### Static client registration as a later optimization

The broker short-circuits DCR entirely when `entry.clientId` is set. Since
every Geode install otherwise registers its own dynamic client with the same
`client_name: "Agent Threads"`, Compass will accumulate one registered client
per install, and every user's consent screen will name an unverified client.
Pre-seeding a single **verified static client** for Agent Threads and shipping
its `client_id` in Geode's Compass preset removes the per-install DCR round
trip and makes the consent screen trustworthy. Worth doing once the dynamic
path works — not before.

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

Compass's local `withMcpAuth` wrapper (`app/api/mcp/route.ts:2917`) becomes the
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
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true,
  "scopes_supported": ["mcp:read", "mcp:write", "offline_access"]
}
```

Field-by-field rationale for the non-obvious entries:

- `code_challenge_methods_supported` is **load-bearing**: *"If
  `code_challenge_methods_supported` is absent, the authorization server does
  not support PKCE and MCP clients MUST refuse to proceed."* Omitting it breaks
  every client.
- `"none"` in `token_endpoint_auth_methods_supported` is required for Claude's
  CIMD path (public client), and is correct regardless for loopback clients.
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

- **`OAuthClient`** — `clientId`, `clientIdMetadataUrl?` (set for CIMD
  clients), `clientSecretHash?` (null for public clients), `clientName`,
  `redirectUris Json`, `grantTypes Json`, `scope`,
  `tokenEndpointAuthMethod`, `logoUri?`, `clientUri?`, `softwareId?`,
  `registrationAccessTokenHash?`, `registrationMode` (`DCR` | `CIMD` |
  `STATIC`), `metadataFetchedAt?`, `createdAt`, `lastUsedAt`.
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
a `McpActor`.** All 108 gates, every membership assertion, and the "not found
or access denied" non-disclosure behavior carry over untouched.

## Scopes

Start with `mcp:read` and `mcp:write` (plus `offline_access`). This requires a
new `TOOL_SCOPES` map beside `TOOL_GATES` in `lib/mcp-tool-gates.ts`,
classifying all 108 tools — the gates are currently membership-based only and
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
  and the requested scopes; visibly mark unverified dynamic clients (anyone can
  register a client named "Compass Official" — the redirect host is the only
  honest signal a user has). CSRF protection, `X-Frame-Options: DENY` /
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
`mcp-handler@^1.1.0` (latest 2.1.1). Neither upgrade is a prerequisite — 1.26.0
already carries `client_id_metadata_document_supported` in its shared metadata
schemas — but check 2.x of `mcp-handler` for whether the `scope`-parameter and
path-insertion gaps have been closed before hand-rolling around them.

## Phasing

**Phase 1 — make the Geode broker work end to end.** This is the shippable
unit, and the broker defines its exact contents: PRM at the path-inserted URL,
AS metadata at both well-known paths, **DCR**, authorize + consent, token
endpoint with PKCE and lenient `resource`, refresh tokens issued by default,
RFC 7009 revocation for public clients, opaque access tokens,
`mcp:read`/`mcp:write`, the `validateMcpAuth` branch, and the two NextAuth
fixes. Metadata without a working AS is worse than no metadata.

**Phase 2 — lifecycle and reach.** Refresh rotation with reuse detection, a
"Connected apps" panel in Settings (client, scopes, last used, revoke)
alongside the existing API-keys panel, CIMD support plus RFC 9207 `iss` for
direct Claude.ai / Cursor connections, and a verified static client for Agent
Threads shipped as a Geode preset.

**Phase 3 — hardening.** Workspace-scoped consent, a verified-client allowlist,
audit log of authorizations.

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
- **Manual (the acceptance test):** add Compass as an OAuth MCP server in Geode
  via `mcp_register_server` with `type: "oauth"`, complete consent in the Web
  Viewer, and call a Compass tool through `OAuthMcpProxy`. Then force a 401 to
  prove the proxy's auto-refresh path, and revoke from Settings. Secondary:
  Claude and one non-Anthropic client (Cursor or VS Code) against a preview
  deploy. Screenshots of the consent screen per the `pr-checklist`
  visual-verification steps.
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
| CIMD support (document fetch, validation, caching) | 0.5 d |
| Consent screen + `/login` `callbackUrl` + `proxy.ts` fix | 0.5 d |
| Resource-server wiring + `validateMcpAuth` branch + `TOOL_SCOPES` | 0.5 d |
| Tests (unit + probe script) | 1 d |
| Docs (`09-mcp-api.md`) + ADR | 0.5 d |

≈ **5 days** for Phase 1, assuming no surprises from DSQL or `.well-known`
routing.

## Open questions

1. Does Phase 1 include the workspace picker on consent, or does every OAuth
   token start org-wide within the user's memberships?
2. Do we gate DCR behind any signal at all, or accept fully open registration
   with rate limits?
3. Preview deploys: per-branch OAuth (feasible via `VERCEL_BRANCH_URL`) or
   production-only?
4. Should the Geode broker be updated to send RFC 8707 `resource`? Good
   hygiene and spec-conformant, but Compass must tolerate its absence either
   way (see *Client profile*), so this is not a blocker in either direction.
5. Phase 2 or sooner for the verified static Agent Threads client? It removes a
   round trip and fixes the "unverified client" consent wording, at the cost of
   coordinating a `client_id` across two repos.

## References

- MCP [2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
  [AS discovery](https://modelcontextprotocol.io/specification/draft/basic/authorization/authorization-server-discovery),
  [client registration](https://modelcontextprotocol.io/specification/draft/basic/authorization/client-registration),
  [security considerations](https://modelcontextprotocol.io/specification/draft/basic/authorization/security-considerations)
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) (Protected Resource Metadata)
- [Anthropic — connector authentication](https://claude.com/docs/connectors/building/authentication)
- geelen/mcp-remote#224 (no CIMD support); anthropics/claude-code#38102, #37747, #36861 (CIMD regressions)
