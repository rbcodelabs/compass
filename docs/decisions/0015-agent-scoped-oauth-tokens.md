# ADR 0015 — An OAuth Token Binds to an Agent, Not to a User

- **Status:** Proposed
- **Date:** 2026-09-19
- **Amends:** ADR 0014 § *No workspace picker on consent*, and decision 1 of
  `docs/design/mcp-oauth-discovery.md`
- **Design of record:** `docs/design/agent-scoped-oauth.md`
- **Scope:** How an OAuth access token names its acting identity. Does not change
  the OAuth protocol surface, DCR, the scope vocabulary, the tool catalog, or any
  `cmp_…` API key behavior.

## Context

ADR 0014 shipped on 2026-09-18 (PR #258, `fe30882`). Its central property holds:
an OAuth token is just another way to produce an `McpActor`, and
`lib/mcp-authz.ts` was untouched.

The actor it produces is `purpose: "USER"` — pinned as a literal at
`lib/mcp-auth.ts:145`, with an explicit comment that an OAuth token must never
take the `AGENT` path. Verified live against production on 2026-09-19 through a
real Geode connection, `get_current_identity` returns `purpose: "USER"`,
`agent: null`, and seven workspaces: every membership across every organization.

Compass separately has a built agent authorization model, and OAuth engages none
of it:

| Constraint | Enforced at |
|---|---|
| Reach limited to unrevoked `AgentWorkspaceGrant` rows, per-workspace READ or WRITE | `lib/agent-access.ts:12-17` |
| Admin assertions throw *"Human administrator required."* | `lib/mcp-authz.ts:122`, `:195`, `:380` |
| 17 `DENY` entries barring agent identities from specific tools | `lib/mcp-tool-gates.ts:615`, `:624` |
| `COMPASS_AGENTS_ENABLED=1` and `Agent.status === "ACTIVE"`, re-checked per request | `lib/mcp-auth.ts:60-64` |
| Every mutation writes an `AgentToolCall` audit row | `lib/agent-activity.ts:6-21` |

Decision 1 justified the omission on the grounds that an OAuth token carries the
same reach a per-user `cmp_…` key already has. That is true, and it is the wrong
comparison. The credential OAuth actually replaces in practice is an **agent**
key minted at `/settings/agents`. Against that, OAuth is a privilege increase.

## Decision

**Bind the token to an agent at consent time, and store the binding as an
explicit mode on the token.**

`OAuthAuthorizationCode`, `OAuthToken` and `OAuthConsent` each gain
`authorizationMode VarChar(10)` (`"AGENT"` | `"USER"`) and a nullable
`agentId Uuid`, non-null iff the mode is `AGENT`. The mode is stored explicitly
rather than inferred from `agentId IS NULL`, because a null must not be
ambiguous between "the user elected the override" and "this row predates agent
binding".

`validateOAuthAccessToken` gains one branch that returns `purpose: "AGENT"` with
the `agentId` and a `credentialId`. Everything downstream engages unchanged.

### The central property survives, and was checked rather than assumed

`app/api/mcp/route.ts:3549-3557` already forwards `purpose`, `agentId` and
`credentialId` into `runWithMcpActor`. `agentWorkspaceWhere`, the three admin
assertions, and `applyToolGate` all branch on `actor.purpose === "AGENT"` and
need no edit. **`lib/mcp-authz.ts` is genuinely untouched.**

The trace turned up one thing the claim hides. `withAgentActivity`
(`lib/agent-activity.ts:7`) throws *"Incomplete agent identity."* unless
`credentialId` is set, and the current OAuth branch
(`lib/mcp-auth.ts:143-152`) does not return one. Bind an agent without adding it
and every read works while every write fails — a half-working connection that
reads as a Compass bug. `credentialId` is therefore part of this decision, not an
implementation detail, and it makes `AgentToolCall.credentialId` polymorphic
across `ApiKey.id` and `OAuthToken.id`, so a `credentialType` discriminator ships
with it.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **`agentId` on the token, chosen at consent** (chosen) | Binding is a first-class, revocable, auditable token property; enforced at the same point as every other credential; `lib/mcp-authz.ts` untouched | DSQL migration; materially more complex consent screen; forces re-consent |
| **Client names the agent per request** (header or `_meta`) | No schema change; one connection could act as several agents | Geode's `OAuthMcpProxy` injects only `Authorization`, so it is unimplementable for the primary consumer; and it moves the privilege decision from the authorizing human to the untrusted client — the same party whose `client_name` the consent screen already warns about |
| **Per-agent RFC 8707 `resource` audience** | Reuses an existing protocol mechanism; no new column; audience check becomes the binding check | The Geode broker never sends `resource` at all, so the main client cannot express a binding; and `lib/mcp-auth.ts:130` enforces the spec's hardest MUST as a single equality predicate, which would have to become a matcher — weakening the one line that prevents audience confusion |
| **Binding encoded in the scope string** (`mcp:agent:<uuid>`) | No new column | Scopes are advertised statically; a client receiving no `scope` in the challenge requests everything advertised; `resolveScope` (`lib/oauth/authorize-request.ts:182`) would silently drop an unrecognised entry; `scope` is `VarChar(255)`. Requires unpicking the scope model for no gain |

## Consequences and sub-decisions

### Failure is refusal, never downgrade

An agent-bound token whose agent is suspended, deleted, or owned by another
user — or presented while `COMPASS_AGENTS_ENABLED` is unset — is **invalid**,
returning 401. It is never resolved as `purpose: "USER"`.

This is the single most important line in the change. A downgrade would make an
environment-variable flip into a privilege escalation, and a suspended agent
would keep working through OAuth while failing through its own key. It mirrors
the `ApiKey` AGENT path at `lib/mcp-auth.ts:60-64` exactly, including
re-checking agent liveness on every request rather than trusting it from
issuance.

The accepted consequence: once agent-bound tokens exist, turning
`COMPASS_AGENTS_ENABLED` off 401s all of them. That is the correct failure
direction and it makes the flag a one-way door in practice.

### Zero effective reach blocks approval

An inline-created agent has no `AgentWorkspaceGrant` rows, so its token
authenticates, passes every gate, and returns *"Workspace not found or access
denied"* for every call — a connection that reports success and does nothing.

So: the consent screen computes and displays **effective reach** from grants
rather than memberships, and disables "Allow access" when that reach is empty,
naming the remedy. A consent screen that can mint a dead credential is worse
than one that refuses.

Grant selection appears only when creating an agent inline. Selecting an
*existing* agent shows its reach read-only and offers no editing: grants are
workspace-administration state, and letting a consent screen quietly widen a
long-lived agent's standing reach would be a real privilege change smuggled into
an authorization flow.

### The grantable set is narrower than it looks

`grantWorkspaceAgent` (`app/settings/agents/actions.ts:62-83`) requires
`resolveWorkspaceAdmin` — workspace ADMIN or org ADMIN/OWNER
(`lib/permissions.ts:128-134`) — and requires the agent's owner to be a current
workspace member. At consent time the grantable set is therefore workspaces
where the authorizing user is both a member and an admin.

For an org owner that is everything and the constraint is invisible. **For a
plain member of someone else's organization it is empty**, and their
inline-created agent cannot reach the workspaces they work in. The screen states
the count it could not offer and why. Whether to relax the grant rule for this
case is deliberately left open rather than decided here.

### Three narrowing mechanisms collapse to two

Scopes gate the **verb** (`mcp:read`/`mcp:write`, enforced pre-dispatch at
`app/api/mcp/route.ts:3534-3545`). Grants gate the **noun**. They intersect and
neither widens the other — which already works, via `applyToolGate` setting
`requiredAgentAccess` (`lib/mcp-tool-gates.ts:640`) and `agentWorkspaceWhere`
filtering on it (`lib/agent-access.ts:16`).

`OAuthToken.scopeWorkspaceId` is **superseded and stays null**. Beyond being
redundant, it is not a complete boundary as built: `assertActorWorkspaceScope`
(`lib/mcp-authz.ts:94-98`) fires only for `RESEARCH` and `AGENT_TURN`, and
`assertWorkspaceAdmin`, `assertOrgMemberBySlug` and `assertOrgAdminBySlug` never
consult it. Making it load-bearing would mean fixing three more call sites to
express strictly less than a grant set does. The column stays (dropping a column
on DSQL helps nobody) with its comment corrected.

### The admin override is in scope, and gated on admin-everywhere

A workspace or org admin may elect `USER` mode, reproducing today's behavior. The
predicate is **org `OWNER`/`ADMIN` in every organization the user belongs to**,
re-evaluated on refresh as well as at issuance.

This is the only coherent rule available: a user-mode token reaches every
organization the user belongs to, so being admin of one does not justify
unrestricted reach into another. It means the user already personally holds every
authority the token would carry.

It is presented as a collapsed disclosure beneath the agent list, never as a
radio button among them. Expanding it names the constraints being waived,
enumerates every organization and workspace (reusing `grantedAccess()` from
`lib/oauth/consent.ts:323`, which is exactly where that function belongs now),
requires a **typed confirmation** of the user's own email, and relabels the
primary action *"Allow full account access"* in destructive styling. When the
predicate fails the disclosure is not rendered at all. Issuance writes an
`AgentAuditLog` row, because this is the one path with no per-call trail.

### The "only input is a signature" invariant is amended, not abandoned

`app/oauth/consent/route.ts` states that the POST reads nothing unsigned. Agent
binding breaks that literally: the binding is a user choice made at the consent
screen, which the GET that signed the blob could not have known, so `binding`,
`agentName`, `grantWorkspaceIds[]` and `confirmation` arrive unsigned.

CSRF is unaffected — the blob is still required and still bound to
`session.user.id`, and the redirect URI, client, scope, PKCE challenge and
audience all remain inside the signature, so the swap-`evil.com`-between-render-
and-submit attack the invariant was written against still has nowhere to land.
Every unsigned field is re-validated server-side against the session user, so
the worst a tampered field achieves is a binding the user was independently
entitled to choose. The module doc is updated to say this rather than leaving it
implicit.

The alternative — a two-step consent that re-signs the blob with the binding
folded in — preserves the invariant literally and buys nothing, because the
server-side re-validation is mandatory either way: a signature proves a value
was authentic when rendered, not that it is still authorized.

### Existing tokens are revoked, not grandfathered

The migration revokes every live `OAuthToken` and deletes every `OAuthConsent`
row. Grandfathering would leave the exact token that exposed this gap
over-privileged indefinitely; "downgrading" has nothing coherent to downgrade
*to*, since without an `agentId` there is no grant set. The population is one
day old, and clients recover through a failed refresh, which surfaces as a
re-authorization prompt.

Two short-circuits run before the consent screen renders
(`app/oauth/authorize/page.tsx:112-126`) and either one, left alone, ships this
feature as a no-op:

- **`OAuthConsent`** — `hasStoredConsent` (`lib/oauth/consent.ts:234`) issues a
  code and redirects without rendering. The rows must be **deleted**, not
  migrated.
- **The `__Host-` consent cookie** — `consentCookieApproves`
  (`lib/oauth/consent.ts:196`) is checked first, ORed with the DB row, lives
  **90 days** (`:43`), and is client state no migration can reach. On the very
  browser that authorized the live connection, the fix would be bypassed until
  December.

The cookie short-circuit is therefore **retired**. It saved one indexed read on
reconnect, and it is now a non-revocable second source of truth for a
security-relevant decision.

### The Connected apps panel becomes a prerequisite

A remembered consent replays its remembered binding, so without a Settings
surface there is no way to change one. ADR 0014 listed "a Connected apps panel"
under *Not in this decision*; this decision promotes it to a requirement, with
revoke and "reconnect as a different agent" (which deletes the `OAuthConsent`
row).

### `AGENT_TURN` is explicitly out

`AGENT_TURN` credentials are minted server-side with a 5-minute expiry and
conversation- plus claim-scoping for a single in-app turn
(`lib/agent-mcp-key.ts:55`). No external client holds one, no authorization-code
flow could produce one, and `validateMcpAuth` requires both a `scopeWorkspaceId`
and a live `expiresAt` for it (`lib/mcp-auth.ts:65`). Binding a 1-hour token with
a 30-day refresh to a turn-scoped purpose is incoherent, not merely
unscheduled — so `authorizationMode` is a closed two-way switch, never a
pass-through of a stored purpose string.

## Risks

- **The escalation path just moves.** Any user can still mint an unrestricted
  per-user `cmp_…` key from Settings with no admin predicate, so this does not
  reduce the maximum authority a user can obtain — only what they grant a
  third-party client in one click. The trade is defensible because the threat
  models differ: the key path is entirely user-initiated, while the OAuth path
  is reachable by any software that can get the user to a URL under a name it
  chose itself. But it is a knowing trade, and if it is rejected, per-user keys
  need narrowing too.
- **Non-admin users get a narrower connection than their own API key gives
  them.** Invisible in a single-owner organization; defining for anyone else.
- **Geode's behavior on a failed refresh is unverified.** The Phase 1 design
  records auto-refresh on a 401 but says nothing about refresh itself failing,
  which is what mass revocation causes. If it dead-ends rather than re-prompting,
  recovery means removing and re-adding the server. Check `obsidian-claude-threads`
  before the migration runs.
- **The fix is larger than the thing it fixes** — roughly 7 days against Phase
  1's 4.5, mostly the override ceremony and the Settings panel.
- **The consent screen is getting tall.** Phase 1 already needed the card pinned
  to the viewport with an internal scroll region to keep both buttons above the
  fold (`app/oauth/authorize/page.tsx:132-150`), measured at 1280×800. This adds
  a whole section above them. Re-measure rather than assuming the fix holds.

## What would make us revise this

- A second MCP client appears that *can* carry a per-request identity hint, and
  users want one connection acting as several agents. Option B becomes live
  again, additively.
- The grant rule is relaxed so an agent owner may grant read access to any
  workspace they are a member of. That would make the non-admin case disappear
  and remove the design's sharpest limitation.
- Per-user `cmp_…` keys are narrowed. The escalation-path risk above would
  close, and the override predicate could then be relaxed to match.
