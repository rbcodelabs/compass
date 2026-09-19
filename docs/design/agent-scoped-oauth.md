# Design — Agent-Scoped OAuth for the Compass MCP Server

- **Status:** Proposed (not implemented)
- **Date:** 2026-09-19
- **Supersedes:** decision 1 of `docs/design/mcp-oauth-discovery.md` ("No
  workspace picker on consent"), and the corresponding section of ADR 0014
- **Design of record it extends:** `docs/design/mcp-oauth-discovery.md`
- **ADR candidate:** `docs/decisions/0015-agent-scoped-oauth-tokens.md`
- **Compass tracking:** solution `d1c8d2a1-1850-4485-8109-e867d2c8e733` under
  opportunity `91588247-78df-49d1-bd8a-dd782e26eeef`
- **Scope:** Bind an OAuth access token to a workspace agent at consent time, so
  that every constraint the agent authorization model already enforces applies to
  it. Does not change the tool catalog, the OAuth protocol surface, DCR, the
  scope vocabulary, or any `cmp_…` API key behavior.

## Context — what shipped, and what it skipped

Phase 1 OAuth shipped to production on 2026-09-18 (PR #258, `fe30882`). It does
exactly what ADR 0014 says it does: a client pastes `…/api/mcp`, the user is
bounced through login and a consent screen, and a token comes back that resolves
to an `McpActor`.

The actor it resolves to is `purpose: "USER"`, pinned as a literal at
`lib/mcp-auth.ts:145` with the comment *"An OAuth token must never be able to
take the `RESEARCH` path … or the `AGENT` paths."* The consent screen never asks
which identity the connection should act as, because decision 1 said it did not
need to.

Compass also has a deliberate, fully built agent authorization model. OAuth
routes around all of it.

### The gap, verified live

Called through a real Geode OAuth connection against production on 2026-09-19,
`get_current_identity` returns:

```json
{ "purpose": "USER", "userId": "597eeb25-…", "agent": null,
  "workspaces": [ 7 workspaces across rbcodelabs ] }
```

Seven workspaces — every membership the user has. That is the same answer a
per-user `cmp_…` key gives, which is what decision 1 promised. The problem is
what it is being compared against.

An `AGENT`-purpose key is subject to four constraints. An OAuth token is subject
to none of them:

| Constraint | Enforced at | Applies to OAuth today? |
|---|---|---|
| Reach limited to workspaces with an unrevoked `AgentWorkspaceGrant`, per-workspace READ or WRITE | `agentWorkspaceWhere`, `lib/agent-access.ts:12-17` | No |
| `assertWorkspaceAdmin` / `assertOrgAdminBySlug` / admin `assertScoringModelAccess` throw *"Human administrator required."* | `lib/mcp-authz.ts:122`, `:195`, `:380` | No |
| 17 `DENY` entries barring agent identities from specific tools | `AGENT_TOOL_POLICY`, `lib/mcp-tool-gates.ts:615` and `:624`, applied at `:637-639` | No |
| Requires `COMPASS_AGENTS_ENABLED=1` and `Agent.status === "ACTIVE"`, re-checked on every request | `lib/mcp-auth.ts:60-64`, `lib/agent-access.ts:12-15` | No |
| Every mutation writes an `AgentToolCall` audit row | `withAgentActivity`, `lib/agent-activity.ts:6-21` | No |

> **Correction to the brief.** The framing task said "4 `DENY` entries". The
> actual count is **17**: six research-lifecycle tools
> (`lib/mcp-tool-gates.ts:615`) and eleven others — comment-body edits,
> `create_workspace`, plan approval/rejection, release authorization, and the
> four scoring-model administration tools (`:624`). The gap is four times wider
> than stated. Nothing else in the brief's evidence was overstated; the live
> `get_current_identity` result reproduced exactly.

### Why the original design missed it

Decision 1 justified having no picker on the grounds that *"an OAuth token
carries the same reach a per-user `cmp_…` key already has."* That sentence is
true and it is the wrong comparison.

It is true against a **per-user** key. Rick's actual working credential is an
**agent** key minted at `/settings/agents`. Measured against the credential OAuth
really replaces in practice, OAuth is a privilege *increase* — it hands back the
admin tools, the 17 denied tools, and every ungranted workspace, and it drops
the audit trail.

The shipped schema half-anticipated this. `OAuthToken` has a `scopeWorkspaceId`
column (`prisma/schema.prisma`, `oauth_tokens`) that is always null, described as
"reserved for a future workspace picker". It has no `agentId` column, because
nobody was modelling agent identity as the thing a token might carry.

### Interim posture

Phase 1 stays live and we fix forward. This is not a rollback design, and the
reasoning is worth recording rather than assumed: consent requires an
authenticated Compass session, so a token can only ever be minted for a user who
is already signed in, and it grants nothing that user could not obtain in three
clicks from `/settings` as a per-user key. The exposure is a convenience
asymmetry, not a new capability.

## Goal and non-goals

**Goal.** The authorizing human chooses, on the consent screen, which of their
agents the connection acts as — or creates one there — and the issued token is
bound to it, so all five constraints above apply with no change to
`lib/mcp-authz.ts`.

**Non-goals.**

- Changing the OAuth protocol surface. No new endpoints, no metadata changes, no
  new scopes, no DCR changes. Every client that works today keeps working.
- Narrowing per-user `cmp_…` keys. See *The escalation path just moves* below —
  this is deliberate, and it is an open question, not an oversight.
- `AGENT_TURN`. Explicitly out; see *`AGENT_TURN` is out of scope*.
- A workspace picker built on `scopeWorkspaceId`. Superseded; see *Three
  narrowing mechanisms, collapsed to two*.

## Verifying the load-bearing claim first

ADR 0014's central property is that an OAuth token is just another way to
produce an `McpActor`, so `lib/mcp-authz.ts` and every tool gate are untouched.
That property is worth more than this feature, so it was checked against the
code rather than assumed.

Trace a hypothetical token returning `{ purpose: "AGENT", agentId, userId,
credentialId }` from `validateOAuthAccessToken`:

| Step | Code | Change needed? |
|---|---|---|
| Actor construction | `app/api/mcp/route.ts:3549-3557` already forwards `purpose`, `agentId` and `credentialId` verbatim | **None** |
| Workspace reach | `agentWorkspaceWhere`, `lib/agent-access.ts:12-17` — branches on `actor.purpose !== "AGENT"` | **None** |
| Admin assertions | `lib/mcp-authz.ts:122`, `:195`, `:380` — branch on `actor.purpose === "AGENT"` | **None** |
| Per-tool policy | `applyToolGate`, `lib/mcp-tool-gates.ts:637-641` — sets `requiredAgentAccess` from `AGENT_TOOL_POLICY` | **None** |
| Audit | `withAgentActivity`, `lib/agent-activity.ts:6-7` | **See below** |

`lib/mcp-authz.ts` is genuinely untouched. The claim survives. But the trace
turned up two things that are not visible from the ADR:

**1. `credentialId` is mandatory, and the OAuth branch does not return it.**
`lib/agent-activity.ts:7` reads:

```ts
if (!actor.agentId || !actor.userId || !actor.credentialId) throw new McpAuthzError("Incomplete agent identity.")
```

`validateOAuthAccessToken` (`lib/mcp-auth.ts:143-152`) returns no `credentialId`.
Bind an agent without adding one and **every mutating tool call fails** with
"Incomplete agent identity." while every read succeeds — a half-working
connection that looks like a Compass bug. The fix is to select and return
`accessToken.id`, but it has a consequence: `AgentToolCall.credentialId` is a
bare `@db.Uuid` that holds an `ApiKey.id` today. It becomes polymorphic across
two tables with no discriminator, which matters for the "Recent agent activity"
panel (`app/settings/agents/page.tsx`) and for anyone later trying to answer
"which credential did this?" Recommend adding `credentialType VarChar(10)`
(`"API_KEY"` | `"OAUTH"`) alongside, backfilled to `"API_KEY"`.

**2. `scopeWorkspaceId` is not a complete security boundary as built.**
`assertActorWorkspaceScope` (`lib/mcp-authz.ts:94-98`) fires only for `RESEARCH`
and `AGENT_TURN`. For `USER` and `AGENT` the column is honoured *only* inside
`agentWorkspaceWhere` (`lib/agent-access.ts:11`, `:17`), and
`assertWorkspaceAdmin` (`:120`), `assertOrgMemberBySlug` (`:170`) and
`assertOrgAdminBySlug` (`:191`) never call it. A `USER`-purpose token with
`scopeWorkspaceId` set would still pass `assertOrgMemberBySlug` for the whole
organization. This is a direct argument against building workspace narrowing on
that column — see below.

**A related property worth recording accurately, because it is easy to
overstate.** The grant model does *not* narrow the three org-slug-gated tools at
the gate: `list_workspaces` (`mcp-tool-gates.ts:185`), `list_scoring_models`
(`:433`) and `list_top_opportunities` (`:451`) all pass `assertOrgMemberBySlug`
for any org the *owner user* belongs to. Each handler then re-filters by
`agentWorkspaceWhere` — `app/api/mcp/route.ts:355`, `lib/scoring-tool-handlers.ts:47-48`,
and the documented behavior of `listTopOpportunities`. So no tool leaks today,
but the invariant rests on per-handler discipline rather than a single choke
point. This is pre-existing and inherited, not introduced here; it is named so
that a future org-scoped tool author knows the gate will not save them.

## Alternatives considered

Three real options were worked through, each rejected for a specific, checkable
reason rather than on taste.

### A. `agentId` on the token, chosen at consent — **recommended**

Add a nullable `agentId` and an explicit mode discriminator to the code, token
and consent rows. The consent screen picks the binding.
`validateOAuthAccessToken` branches once. Everything downstream engages as
verified above.

*Cost:* a DSQL migration, a materially more complex consent screen, and a forced
re-consent. *Benefit:* the binding is a first-class property of the token,
revocable, auditable, and enforced at exactly the point every other credential
is enforced.

### B. Client names the agent per request

Leave tokens user-purpose; let the client pass an agent id on each call (a header,
or an MCP `_meta` field), validated against the caller's agents.

Attractive in the abstract: no schema change, and one connection could act as
several agents for different tasks.

Rejected on two concrete grounds. First, it is unimplementable for the primary
consumer — Geode's `OAuthMcpProxy` injects only `Authorization: Bearer …` on the
way out (`docs/design/mcp-oauth-discovery.md`, *Client profile*), so there is no
channel for the binding and no reason any other MCP client would grow one.
Second, and worse, it relocates the binding decision from the authorizing human
to the client software. The client is the untrusted party in this system — the
consent screen's entire unverified-application treatment exists because
`client_name` is attacker-chosen. Letting it choose its own privilege level
inverts that.

### C. Encode the binding in the RFC 8707 `resource` audience

Mint tokens whose audience is per-agent, e.g.
`https://compass.rbcodelabs.com/api/mcp#agent=<uuid>` or a path variant. Elegant:
it reuses a protocol mechanism that already exists, needs no new column, and the
audience check becomes the binding check.

Rejected on two verified facts. The Geode broker **never sends `resource`**, at
authorize or at token exchange (`mcp-oauth-discovery.md`, *Client profile*;
`resolveResource` in `lib/oauth/resource.ts` exists precisely to default it), so
the primary consumer cannot express a binding this way and would always land on
the default. And `mcp-auth.ts:130` enforces the spec's hardest MUST as a single
equality predicate `resource: mcpResourceUri()`. Per-agent audiences would turn
that into a parser plus a matcher, weakening the one line where audience
confusion is actually prevented, in exchange for a mechanism the main client
cannot use.

### D. Encode the binding in the scope string

`mcp:agent:<uuid>` alongside `mcp:read`/`mcp:write`.

Rejected: scopes are advertised statically in `scopes_supported`
(`lib/oauth/constants.ts:31`), a client that receives no `scope` in the challenge
requests *everything* advertised, `resolveScope` (`lib/oauth/authorize-request.ts:182-198`)
intersects the request against `filterSupportedScopes` and would silently drop
an unrecognised entry, and `OAuthAuthorizationCode.scope` is `VarChar(255)`.
Making this work means unpicking the scope model to no benefit.

## Recommended design

### The binding

An issued token is in exactly one of two **authorization modes**:

- **`AGENT`** — bound to an `Agent` owned by the authorizing user. Resolves to
  `purpose: "AGENT"`. This is the default and the overwhelmingly common case.
- **`USER`** — the admin override. Resolves to `purpose: "USER"`, i.e. today's
  Phase 1 behavior, reachable only through a deliberate escalation ceremony.

The mode is stored explicitly rather than inferred from `agentId IS NULL`.
Inferring would make a legacy row and an elected override indistinguishable,
which is precisely the ambiguity that turns a security column into a footgun.

### Data model

Additive only. Three tables, two columns each, one index. DSQL rules per
`docs/design/mcp-oauth-discovery.md` — UUID PKs, no `@updatedAt`, no FK
constraints, `ASYNC` indexes, one DDL per transaction.

```prisma
model OAuthAuthorizationCode {
  // …existing…
  /// "AGENT" | "USER". Explicit rather than inferred from agentId — a null
  /// agentId must not be ambiguous between "user override elected" and
  /// "row predates agent binding".
  authorizationMode String  @default("USER") @map("authorization_mode") @db.VarChar(10)
  /// Non-null iff authorizationMode = "AGENT". Agent.id, owned by userId.
  agentId           String? @map("agent_id") @db.Uuid
}

model OAuthToken {
  // …existing…
  authorizationMode String  @default("USER") @map("authorization_mode") @db.VarChar(10)
  agentId           String? @map("agent_id") @db.Uuid

  @@index([agentId], map: "idx_oauth_tokens_agent")
}

model OAuthConsent {
  // …existing, @@unique([userId, clientId]) unchanged…
  authorizationMode String  @default("USER") @map("authorization_mode") @db.VarChar(10)
  agentId           String? @map("agent_id") @db.Uuid
}
```

`OAuthConsent`'s unique key stays `(userId, clientId)`: one connection has one
binding. The binding is data on that row, not part of its identity — a returning
client replays the remembered binding rather than being offered a second one.

`AgentToolCall` gains `credentialType VarChar(10)` (`"API_KEY"` | `"OAUTH"`),
backfilled to `"API_KEY"`, so `credentialId` stops being silently polymorphic.

`OAuthToken.scopeWorkspaceId` is **not** removed and **not** used. It stays null
forever; see below.

**Migration sizing.** Migration 055 needed roughly three POSTs to apply in both
preview and production because 4 DDL plus 9 `ASYNC` index submissions exceed the
route's `maxDuration = 60`. This migration is 8 `ALTER TABLE … ADD COLUMN` (one
clause per statement — multi-clause `ALTER` on DSQL is untested here and not
worth discovering during a production apply), 1 `ASYNC` index, and two data
statements (the backfill and the revocation below). Budget **1–2 POSTs**, and
write it to resume cleanly either way, since nullable `ADD COLUMN` on DSQL does
not rewrite the table and should be fast — the single `ASYNC` index is the only
slow submission.

### Where `purpose` is decided

One branch, in the one file ADR 0014 designated for it:

```ts
// lib/mcp-auth.ts, inside validateOAuthAccessToken
if (accessToken.authorizationMode === "AGENT") {
  // Mirrors the ApiKey AGENT path at lib/mcp-auth.ts:60-64 exactly. A token
  // whose agent has been suspended, or whose deployment has agents switched
  // off, is INVALID — never silently downgraded to USER. Downgrading would
  // make an env-var flip a privilege escalation.
  if (!agentsEnabled() || !accessToken.agentId) return { valid: false }
  const agent = await prisma.agent.findFirst({
    where: { id: accessToken.agentId, ownerUserId: accessToken.userId, status: "ACTIVE" },
    select: { id: true },
  })
  if (!agent) return { valid: false }
  return {
    valid: true,
    userId: accessToken.userId,
    purpose: "AGENT",
    agentId: accessToken.agentId,
    credentialId: accessToken.id,   // required by withAgentActivity — see above
    scopeWorkspaceId: null,
    scopes: parseScope(accessToken.scope),
  }
}
```

Three properties of this shape are deliberate and each is load-bearing:

1. **Agent liveness is re-checked per request**, not trusted from issuance. A
   suspended agent stops working immediately on the OAuth path exactly as it
   does on the key path. This is a second DB read on the hot path; the `ApiKey`
   AGENT branch already pays it, and there is no FK to join across
   (`relationMode = "prisma"`), so two reads it is.
2. **Failure is `{ valid: false }`, never a downgrade.** A 401 sends the client
   back through discovery and consent. A downgrade would hand it more authority
   than it was granted.
3. **`scopeWorkspaceId` is pinned null on this path**, so there is exactly one
   mechanism narrowing workspaces and it is the grant model.

### Three narrowing mechanisms, collapsed to two

There are now potentially three: scopes, `scopeWorkspaceId`, and grants. Two is
the right number.

| Mechanism | Governs | Status |
|---|---|---|
| `mcp:read` / `mcp:write` | The **verb**. Enforced pre-dispatch at `app/api/mcp/route.ts:3534-3545` as a 403 with `insufficient_scope` | Unchanged |
| `AgentWorkspaceGrant` | The **noun** — which workspaces, at which access level | New for OAuth; already exists for keys |
| `OAuthToken.scopeWorkspaceId` | Would govern a single workspace, no access level | **Superseded. Stays null.** |

`scopeWorkspaceId` is retired rather than built on, for two reasons beyond
redundancy. It is not fully enforced (verified above:
`assertWorkspaceAdmin`/`assertOrgMemberBySlug` never consult it), so making it
load-bearing would mean fixing three more call sites. And it expresses a single
id with no access level, where grants express a *set* with per-workspace
READ/WRITE. Grants strictly dominate. The column stays because dropping a column
on DSQL is a DDL nobody needs; the schema comment gets updated to say
"superseded by agentId + AgentWorkspaceGrant; always null" so the next reader
does not resurrect it.

**Composition rule: scopes gate the verb, grants gate the noun, they intersect,
and neither widens the other.** This already works and needs no new code —
`applyToolGate` sets `actor.requiredAgentAccess` from `AGENT_TOOL_POLICY`
(`lib/mcp-tool-gates.ts:640`), and `agentWorkspaceWhere` then filters to WRITE
grants when that is `"WRITE"` (`lib/agent-access.ts:16`).

One rough edge worth knowing and not worth fixing in v1: a token holding
`mcp:write` bound to an agent with only READ grants passes the 403 scope check
and then fails per-tool with *"Workspace not found or access denied."* The
diagnosis is correct but the message points at the wrong layer.

### Consent screen

The screen keeps its Phase 1 structure — signed request blob, unverified-client
treatment, redirect host, scope list, two forms — and replaces the
**"Where it will have access"** section rather than adding beside it.

```
┌──────────────────────────────────────────────────────┐
│  Authorize Agent Threads                             │
│  …connecting as rick@rbcodelabs.com                  │
│                                                      │
│  ⚠ Unverified application        [unchanged]         │
│  http://127.0.0.1:54312/callback                     │
│                                                      │
│  WHAT IT WILL BE ABLE TO DO      [unchanged scopes]  │
│                                                      │
│  ACT AS                                    ← new     │
│   ( ) Compass PM Agent                               │
│         Compass · Geode · Golden Wealth              │
│   (•) Research Assistant                             │
│         Compass (read only)                          │
│   ( ) Create a new agent…                            │
│         [ name ]                                     │
│         Give it access to:                           │
│           [x] Compass      [x] Geode                 │
│           [x] Golden Wealth                          │
│           (4 workspaces need an admin to grant)      │
│                                                      │
│  WHERE IT WILL HAVE ACCESS                 ← derived │
│   rbcodelabs                                         │
│     Compass (read only)                              │
│                                                      │
│  ▸ Authorize as yourself instead           ← new     │
│                                                      │
├──────────────────────────────────────────────────────┤
│  [ Cancel ]            [ Allow access ]              │
└──────────────────────────────────────────────────────┘
```

Five rules govern it.

**1. "Where it will have access" is computed from grants, not memberships.** In
Phase 1 this section enumerated every workspace the user belongs to, because
that was the truth. Now it must show the token's *effective reach* — the
workspaces the chosen agent actually holds an unrevoked grant in, with the
access level. It is the same compensating control doing the same job against a
narrower grant, and it must update as the selection changes.

**2. Zero effective reach blocks approval.** This is the sharpest requirement in
the design. An agent with no grants produces a token that authenticates, passes
every gate, and then returns *"Workspace not found or access denied"* for
literally every call — a connection that reports success and does nothing. If
the current selection resolves to an empty reach, "Allow access" is disabled and
the screen says so in plain language, naming the remedy (ask a workspace admin
to grant access at `/{org}/{workspace}/settings`). A consent screen that can mint
a dead credential is worse than one that refuses.

**3. Agent selection and grant selection are the same interaction, but only for
a new agent.** Selecting an *existing* agent uses its existing grants and offers
no editing — grants are workspace-administration state, they are visible and
revocable at `/settings/agents` and in each workspace's settings, and letting a
consent screen silently widen an agent's standing reach would be a real
privilege change smuggled into an authorization flow. Creating an agent
*inline* must select grants, because otherwise it mints the dead credential rule
2 forbids. So: existing agent → read-only reach display; new agent → grant
picker, defaulted to every grantable workspace checked.

**4. The grantable set is narrower than people will expect, and the screen must
say so.** `grantWorkspaceAgent` (`app/settings/agents/actions.ts:62-83`) requires
`resolveWorkspaceAdmin`, which is workspace ADMIN or org ADMIN/OWNER
(`lib/permissions.ts:128-134`), *and* requires the agent's owner to be a current
workspace member (`actions.ts:71`). At consent time the authorizing user is the
agent owner, so the grantable set is:

> workspaces where the user is a member **and** (a workspace ADMIN **or** an
> admin/owner of the containing org)

For Rick, sole owner of `rbcodelabs`, that is all seven and the constraint is
invisible. **For anyone who is a plain member of someone else's organization it
is zero**, and their inline-created agent cannot reach the workspaces they work
in. The screen must state the count it could not offer and why, rather than
silently presenting a short list. See open question 1 — this is the most
consequential thing in the design that Rick's own usage will never surface.

**5. Consent-time grant writes use the same code path as Settings.** The inline
creation calls `createAgent` and `grantWorkspaceAgent` as they exist, including
the membership-touch concurrency guard at `actions.ts:76-77`. No second grant
path.

### The admin override

In scope for v1, and it must look like the broad path it is.

**Who qualifies.** A user-mode token carries reach across *every* organization
the user belongs to, so "admin" has to mean admin of all of them. The predicate
is:

> the user is an `OWNER` or `ADMIN` of **every** organization they are a member
> of (`isOrgAdminRole` over all `OrganizationMember` rows for that user)

This is the only coherent rule available. "Admin of at least one org" is
incoherent — being admin of org A does not justify unrestricted reach into org
B. "Any user, behind friction" gives up the control entirely. Requiring admin
everywhere means the user already personally holds every authority the token
would carry, which is exactly the property an escalation gate should check.

Two consequences to accept knowingly. It is *stricter* than minting a per-user
`cmp_…` key, which any user can do at any time — see the next section. And it is
evaluated at consent time only, so joining a new organization as a plain member
does not retroactively narrow an existing override token; it only blocks the
next authorization. Tokens are 1 hour with 30-day refresh, so the window is
bounded by refresh, not by the access token — unless refresh also re-evaluates
it, which is the cleaner answer and is recommended: `claimRefreshToken`'s caller
re-checks the predicate for user-mode tokens and refuses the rotation if it no
longer holds.

**How it is presented.** Not a radio button in the "Act as" list — a
disclosure below it, collapsed by default, labelled *"Authorize as yourself
instead"*. Expanding it reveals a destructive-styled panel that:

- names the four constraints being waived, in plain language — admin tools,
  the 17 human-only tools, every workspace including ungranted ones, and the
  audit trail;
- enumerates every organization and workspace, reusing the Phase 1
  `grantedAccess()` output (`lib/oauth/consent.ts:323-393`) — which is exactly
  where that function belongs now;
- requires a **typed confirmation** (the user's own email address, which the
  screen already displays) in a text field. Typed confirmation is the standard
  for broad irreversible actions and cannot be triggered by a stray Enter or a
  mis-click;
- changes the primary button to destructive styling and the label *"Allow full
  account access"*.

If the predicate does not hold, the disclosure is not rendered at all, and the
screen explains that agent authorization is the only option available.

**Auditing.** A user-mode authorization writes an `AgentAuditLog` row at
issuance naming the user, client, redirect host and timestamp. The model already
exists (`prisma/schema.prisma`, `agent_audit_logs`) and this is the one path
with no per-call `AgentToolCall` trail, so issuance is the only place it can be
recorded. Confirm the existing column shape fits before assuming this is free.

### An amendment to the "only input is a signature" invariant

`app/oauth/consent/route.ts` currently states, at length and correctly, that the
POST reads *nothing* unsigned: everything that determines what gets issued is
recovered from inside the HMAC blob, so there is no tamper window between the
screen the user read and the code that gets issued.

Agent binding breaks that literally. The binding is a *user choice made at the
consent screen*, so the GET that signed the blob could not have known it. The
POST must accept `binding` (`agent:<uuid>` | `new` | `user`), `agentName`,
`grantWorkspaceIds[]` and `confirmation` as unsigned fields.

This is a real weakening and it should be written into the module doc rather
than left implicit. The resolution:

- **CSRF is unaffected.** The blob is still bound to `session.user.id` and still
  required; a cross-site form cannot mint one, and the redirect URI, client,
  scope, PKCE challenge and audience all remain inside the signature. The
  parameter-tampering attack the invariant was written against — swapping
  `127.0.0.1` for `evil.com` between render and submit — still has nowhere to
  land.
- **Every unsigned field is re-validated server-side against the session user**,
  not trusted: the named agent must exist, be owned by `session.user.id`, and be
  `ACTIVE`; each `grantWorkspaceId` must pass `resolveWorkspaceAdmin`; the
  override predicate must hold; the typed confirmation must equal the session
  user's email.
- **Therefore the worst a tampered field achieves is a binding the user was
  independently entitled to choose.** That is a materially different class of
  outcome from the redirect-URI swap, and it is the line worth drawing.

The alternative that preserves the invariant fully is a two-step consent: GET
renders a binding chooser, an intermediate POST re-signs the blob with the
binding folded in, then a final confirmation screen. It costs a round trip and a
second signed payload and buys nothing the server-side re-validation does not
already provide — the re-validation is mandatory either way, because a signature
proves a value was authentic when rendered, not that it is still authorized.
Recommend the single screen; record the two-step as the fallback if review
disagrees.

### `COMPASS_AGENTS_ENABLED`

Agent keys require it (`lib/mcp-auth.ts:61`), and `agentWorkspaceWhere` returns
`{ id: { in: [] } }` without it (`lib/agent-access.ts:12`).

- **At the consent screen:** when the flag is off, the "Act as" section is not
  rendered and consent behaves exactly as Phase 1 does today — user-mode, no
  ceremony. The flag is the rollout control, and its off-state is the current
  shipped behavior, which is the right thing for it to be.
- **At validation:** an agent-bound token presented while the flag is off is
  **invalid**, returning 401. Not downgraded to `purpose: "USER"`. This mirrors
  `lib/mcp-auth.ts:61` and is the whole reason the branch is written as
  `return { valid: false }` above.

The consequence Rick should accept explicitly: once agent-bound tokens exist,
turning the flag off 401s every one of them. That is the correct failure
direction, but it makes the flag a one-way door in practice. See open question 5.

### `AGENT_TURN` is out of scope

Explicitly, and for a structural reason rather than a scheduling one.
`AGENT_TURN` credentials are minted server-side by `mintScopedMcpKey`
(`lib/agent-mcp-key.ts:55`) with a 5-minute expiry and conversation- plus
claim-scoping, for a single in-app agent turn. No external client ever holds
one; there is no authorization-code flow that could produce one; and
`validateMcpAuth` requires both `scopeWorkspaceId` and a live `expiresAt` for it
(`lib/mcp-auth.ts:65`). Binding a 1-hour OAuth token with a 30-day refresh to a
turn-scoped purpose is incoherent, not merely unimplemented. The
`validateOAuthAccessToken` branch must therefore be a closed two-way switch on
`authorizationMode`, never a pass-through of a stored purpose string.

## Backward compatibility

**Decision: forced re-consent. Revoke every live OAuth token and delete every
stored consent in the migration.**

Existing tokens carry no `agentId`. The three options were:

| Option | Outcome |
|---|---|
| **Grandfather** — null mode keeps resolving to `USER` | Zero disruption, and the exact token that exposed the gap (Rick's live Geode connection) stays over-privileged indefinitely |
| **Downgrade** — resolve to something narrower | There is nothing coherently narrower. With no `agentId` there is no grant set, so "narrower" means "no reach", which is revocation with a worse error message |
| **Forced re-consent** — revoke and re-authorize | One re-click, and the gap closes for everyone at once |

Forced re-consent, for three reasons. The population is tiny — OAuth shipped
yesterday, so realistically one Geode install plus test clients. The clients
recover on their own: a revoked family makes refresh fail, which surfaces as a
re-authorization prompt. And shipping a fix for an over-privileged token while
deliberately leaving that token live is not defensible.

The `USER`-mode code path still exists — it is what the admin override produces.
Legacy rows are backfilled to `authorizationMode = "USER"` so the column is never
null, and then revoked. The two facts are independent and both are needed.

### Two ways to ship this and have it do nothing

Both are short-circuits that run *before* the consent screen renders, at
`app/oauth/authorize/page.tsx:112-126`. Miss either and the new picker is never
shown to the one person it was built for.

**1. `OAuthConsent` rows.** `hasStoredConsent` (`lib/oauth/consent.ts:234-244`)
returns true for `(userId, clientId)` with covering scope, and the page then
issues a code and redirects without rendering anything. Rick's existing consent
row would silently mint another user-mode token forever. **The migration must
delete every `OAuthConsent` row**, not merely add a column to them.

**2. The `__Host-` consent cookie.** `consentCookieApproves`
(`lib/oauth/consent.ts:196-206`) is checked *first*, ORed with the DB row
(`page.tsx:114-119`), has a **90-day** lifetime (`:43`), and is HMAC-signed
client state that no migration can reach. Deleting the DB row does not touch it.
On Rick's own browser — the browser that authorized the live connection — the
fix would be bypassed for ninety days.

Recommendation: **retire the cookie short-circuit entirely.** It exists to save
one indexed DB read on reconnect, the `OAuthConsent` row already does the job
durably, and it is now a second source of truth for a decision that has become
security-relevant and needs to be server-revocable. Dropping it removes a class
of bug rather than versioning around it. If it is kept instead, the payload must
carry the binding and a schema version, and the version must be bumped in this
change — a rename of `CONSENT_COOKIE_NAME` achieves the same thing more bluntly.

### Changing a binding later

A remembered consent replays its remembered binding, which is right for
reconnects and wrong as the only behavior — there would be no way to switch an
existing connection from one agent to another, or from an agent to the override.

This promotes the **"Connected apps" Settings panel** from ADR 0014's *"not in
this decision"* list to a **prerequisite of this one**. It needs to list each
connection with its client, redirect host, binding, scopes and last-used, and
offer revoke plus "reconnect as a different agent" (which deletes the
`OAuthConsent` row so the next authorization shows the screen). With the cookie
short-circuit retired, that is sufficient; with it retained, it is not.

## Security considerations

Everything in `docs/design/mcp-oauth-discovery.md` § *Security requirements*
still applies unchanged. New to this design:

- **Never downgrade; always refuse.** An agent-bound token whose agent is
  suspended, deleted, unowned, or whose deployment has agents disabled must be
  **invalid**, not resolved as `USER`. Every failure mode in the new branch
  returns `{ valid: false }`. This is the single most important line in the
  change, and it is one worth a dedicated test per failure mode.
- **The grant set is evaluated per request, never captured at issuance.**
  `agentWorkspaceWhere` reads `AgentWorkspaceGrant` live, so revoking a grant in
  workspace settings takes effect on the next call with no token revocation and
  no index scan. This is why no grant-change hook is needed, and it is a
  genuinely better property than the token-capture alternative.
- **Consent-time grants must not widen an existing agent.** Only inline-created
  agents get grant selection. Otherwise an attacker-named client could present a
  screen whose grant checkboxes quietly extend a long-lived agent's standing
  reach, and the user would read it as scoping *this connection*.
- **Every unsigned consent field is re-validated server-side** against the
  session user — agent ownership and status, per-workspace admin rights, the
  override predicate, and the typed confirmation. See the invariant amendment
  above.
- **The override predicate is re-evaluated on refresh**, not only at issuance,
  so a user who ceases to be an org admin everywhere loses the override within
  one refresh cycle rather than within 30 days.
- **The audit trail is not optional.** Agent-mode mutations write `AgentToolCall`
  via `withAgentActivity` — which requires `credentialId`, which the OAuth
  branch does not currently return. Shipping without it produces read-only
  connections that fail every write, and shipping a workaround that skips
  `withAgentActivity` for OAuth would silently remove the audit trail that is
  half the point.
- **`credentialId` becomes polymorphic** across `ApiKey.id` and `OAuthToken.id`
  in a bare `@db.Uuid` column with no discriminator. Add `credentialType`.
- **The escalation path just moves** — see below. This design narrows the
  convenient path and leaves the inconvenient one wide, and that is a knowing
  trade, not an oversight.

### The escalation path just moves

Any Compass user can mint an unrestricted per-user `cmp_…` key from Settings at
any time, with no admin predicate and no ceremony. After this change, OAuth is
*harder* than that.

So agent-scoped OAuth does not reduce the maximum authority a user can obtain.
It reduces the authority a user *grants to a third-party client in one click*.
That is the distinction that makes the trade defensible, and it is worth stating
rather than eliding: the two paths have genuinely different threat models. The
key path requires the user to visit Settings, generate, copy and paste — all
under their own initiative, with no external party steering. The OAuth path is
reachable by any software that can get the user to a URL and show them a screen
whose application name it chose itself. The consent screen is the weak link, not
the key page, and this design hardens the weak link.

That reasoning is sound but it is not unanimous, and Rick should decide whether
to accept it or schedule a follow-up narrowing per-user keys. Open question 2.

## Phasing

**Phase 2a — the fix.** Schema plus DSQL migration (including the revoke and the
`OAuthConsent` purge), the consent-screen binding section with effective-reach
display and the zero-reach block, inline agent creation with grant selection, the
`validateOAuthAccessToken` agent branch with `credentialId` and liveness checks,
`credentialType` on `AgentToolCall`, and retirement of the consent cookie
short-circuit.

**Phase 2b — the override**, in the same release. It must not ship *before* 2a:
an override offered while agent binding does not yet work is the only path, so
everyone takes it and it stops being an exception.

**Phase 2c — Connected apps panel**, also in the same release, because it is the
only way to inspect or change a binding.

These are three workstreams, not three releases. Splitting the release leaves
either a screen with no way to undo its choice, or an escalation path with no
alternative.

**Still not scheduled:** CIMD, a verified-client allowlist, `/register` abuse
response beyond the existing rate limit, `AGENT_TURN` over OAuth, and any
narrowing of per-user `cmp_…` keys.

## Verification plan

**Unit.**

- `validateOAuthAccessToken` returns `{ valid: false }` — never a `USER` actor —
  for each of: agent suspended, agent deleted, agent owned by a different user,
  `COMPASS_AGENTS_ENABLED` unset, `authorizationMode` absent or unrecognised.
  One test per failure mode; these are the escalation tests.
- An agent-mode result carries a `credentialId`, asserted directly, because its
  absence fails only at mutation time and only through
  `withAgentActivity`.
- Consent POST rejects: an agent id not owned by the session user; a
  `grantWorkspaceId` the user is not admin of; the override without a matching
  typed confirmation; the override when the predicate does not hold.
- The override predicate itself, across the org-role matrix.
- Effective-reach computation: zero grants → empty; READ-only grant → shown as
  read only; revoked grant → excluded.
- Composition: `mcp:write` + READ-only grant denies a write tool;
  `mcp:read` + WRITE grant 403s a write tool before the gate runs.

**Integration.** Extend `scripts/oauth-mcp-probe.ts` rather than writing a second
harness — it already walks the real chain. Add: authorize with an agent binding
→ exchange → `get_current_identity` asserts `purpose: "AGENT"` and the expected
agent → call a granted-workspace read (succeeds) → call an ungranted-workspace
read (denied) → call an `AGENT_TOOL_POLICY` DENY tool such as `create_workspace`
(denied as "Tool requires a human identity") → call an admin tool (denied as
"Human administrator required") → suspend the agent out of band and assert the
next call 401s.

**Manual.**

- Geode end to end: fresh authorization, pick an agent, confirm reach matches
  the grants, force a 401 to exercise refresh, revoke from Settings.
- The zero-reach case: create an agent inline with no grantable workspaces and
  confirm "Allow access" is blocked with an actionable message. This is the
  requirement most likely to be quietly dropped under time pressure.
- A **non-admin** user in an org they do not administer. This is the case Rick's
  own account cannot reproduce, and the one most likely to be broken.
- The override: confirm it is invisible when the predicate fails, that the
  typed confirmation is required, and that the resulting token reproduces
  today's seven-workspace behavior exactly.
- Screenshots per `pr-checklist`, at 1280 and 390 — the Phase 1 screen already
  needed a scroll-region fix to keep the buttons above the fold
  (`app/oauth/authorize/page.tsx:132-150`), and this design adds a whole section
  above them. Re-measure; do not assume the existing fix still holds.

**Migration.** Via `/api/admin/migrate` using the `dsql-migrate` skill, on
preview first. Verify afterwards that Rick's existing production token is
revoked and that a reconnect renders the new screen rather than short-circuiting
— that single check catches both the `OAuthConsent` and the cookie traps.

## Rough sizing

| Work | Estimate |
|---|---|
| Prisma changes + DSQL migration + revoke/backfill | 0.5 d |
| Consent screen: picker, inline create, grant selection, effective reach, zero-reach block | 1.5 d |
| Admin override: disclosure, typed confirmation, predicate, refresh re-check, audit row | 1 d |
| `validateOAuthAccessToken` branch, `credentialId`, `credentialType` | 0.5 d |
| Consent record + cookie retirement + remembered-binding replay | 0.5 d |
| Connected apps Settings panel | 1 d |
| Tests (unit, probe extension, escalation matrix) | 1.5 d |
| Docs (`09-mcp-api.md`, `19-agents.md`) + ADR | 0.5 d |

≈ **7 days**, against Phase 1's 4.5. Worth saying plainly: the fix is larger
than the thing it fixes. Most of the excess is the override ceremony and the
Settings panel, both of which are consequences of decisions Rick has made
deliberately rather than incidental complexity.

## Open questions needing explicit sign-off

1. **Non-admin users get a narrower connection than a per-user key gives them.**
   The grantable set at consent time is workspaces where the user is a member
   *and* an admin (`app/settings/agents/actions.ts:62-83` →
   `lib/permissions.ts:128-134`). For a plain member of someone else's org that
   set is empty, so agent-scoped OAuth cannot reach the workspaces they actually
   work in. Accept this (agents are *meant* to be deliberately granted), or
   change the grant authorization rule so an owner may grant their own agent
   read access to any workspace they are a member of? **Invisible in Rick's own
   account, defining for everyone else.**

2. **Per-user `cmp_…` keys stay unrestricted and mintable by anyone.** After
   this change OAuth is stricter than the key path, so the maximum authority a
   user can obtain is unchanged. Accept the reasoning in *The escalation path
   just moves*, or schedule a follow-up?

3. **Confirm the forced re-consent.** The migration revokes every live OAuth
   token and deletes every consent record, which breaks Rick's current Geode
   connection once and requires him to re-authorize. Confirmed?

4. **Is the override predicate right?** Org `OWNER`/`ADMIN` in *every*
   organization the user belongs to, re-evaluated on refresh. Stricter than
   alternatives and stricter than minting a key.

5. **`COMPASS_AGENTS_ENABLED` in production.** Two parts: confirm it is `1`
   today (not verifiable from the code, and the live `get_current_identity` call
   took the `USER` path, which does not exercise it), and accept that once
   agent-bound tokens exist, turning it off 401s all of them.

6. **Does Geode re-prompt when refresh fails, or dead-end?** The Phase 1 design
   records that the proxy auto-refreshes on a 401
   (`mcp-oauth-discovery.md`, *Client profile*) but says nothing about refresh
   itself failing, which is what mass revocation causes. If it dead-ends, the
   remedy is remove-and-re-add the server, and that should be known before the
   migration runs, not after. **Cross-repo check against
   `obsidian-claude-threads` before shipping the migration.**

7. **Retire the consent cookie short-circuit?** Recommended (it is a
   non-revocable second source of truth for a now-security-relevant decision),
   but it is a small behavioral regression on reconnect latency.

## References

- `docs/design/mcp-oauth-discovery.md` — Phase 1 design of record
- `docs/decisions/0014-compass-is-its-own-oauth-authorization-server.md`
- `docs/decisions/0009-human-and-agent-task-assignment.md`,
  `docs/content/19-agents.md` — the agent model's own rollout record
- `lib/mcp-auth.ts`, `lib/agent-access.ts`, `lib/mcp-authz.ts`,
  `lib/mcp-tool-gates.ts`, `lib/agent-activity.ts`
- `lib/oauth/*`, `app/oauth/authorize/page.tsx`, `app/oauth/consent/route.ts`
- `app/settings/agents/actions.ts`, `lib/permissions.ts`
