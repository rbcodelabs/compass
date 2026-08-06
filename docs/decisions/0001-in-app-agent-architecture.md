# ADR 0001 — In-App Agent (Claude Agent SDK inside a Vercel Sandbox)

- **Status:** Proposed
- **Date:** 2026-08-06
- **Author:** Rick + Claude Code
- **Supersedes / relates to:** the exploratory spike on branch
  `feat/agent-sdk-sandbox-spike` (draft PR #94) and its findings note
  (`Claude/agent-sdk-sandbox-spike-2026-08-06.md` in the Obsidian vault).
- **Scope of this ADR:** the *architecture* for shipping an in-product agent
  that can answer questions and take actions against a user's Compass data by
  driving Compass's own MCP tool catalog. It does **not** design the chat UI
  visuals or write implementation code — it fixes the load-bearing technical
  decisions so the build can be scoped with confidence.

> This is the first ADR in the repo. Convention going forward: numbered
> markdown files under `docs/decisions/`, `NNNN-short-slug.md`, each with a
> Status/Date header. `docs/content/` is the customer help site (compiled by
> `lib/docs.ts`) — ADRs must **not** go there.

---

## 1. Context

We want an agent inside Compass that a logged-in user can talk to, which can
read and mutate their product-discovery data (opportunities, solutions,
experiments, roadmap, OKRs, feedback…) by calling the same MCP tool catalog
that already backs `/api/mcp`. The spike answered the feasibility questions;
this ADR turns the proven mechanics into committed architecture and names the
one large risk the spike surfaced.

### What the spike proved (evidence, not assumption)

All of the following was observed on a real Vercel preview deploy, not locally:

- **The full chain works:** Vercel Sandbox → Agent SDK `query()` → a custom
  MCP tool → Compass's own `/api/mcp` → Prisma → Aurora DSQL → back out.
  Clean run, `$0.107`, 3 turns. The sandboxed agent reached real data **without
  ever holding a DB credential** — it only makes authenticated MCP calls.
- **Snapshots make it fast.** A one-time "golden" snapshot
  (`session.snapshot()` after `npm install`) boots warm in **~200 ms** vs
  ~10–14 s cold. Request → first streamed token on a warm sandbox is **~2.2 s**;
  the rest of the 19–27 s round trip is **unavoidable LLM/agent work** (turn
  count, reasoning, tool round-trips), identical warm or cold.
- **Streaming is free.** `command.logs()` async iteration maps directly onto a
  Next.js `ReadableStream` — no buffering, no adapter.
- **OIDC federation is already on** for the project, so `@vercel/sandbox`
  authenticates from inside a deployed function with no extra setup.

### Decision drivers

1. Interactive-grade latency (user is waiting) — snapshots clear this bar.
2. **Least-privilege data access** — the agent must only see/do what the acting
   user is allowed to. This is the crux (see §4).
3. Reuse Compass's existing MCP tool catalog rather than reimplementing
   business logic or granting DB access to sandboxed code.
4. Operational simplicity — the repo has **no queue/cron/scheduler today**; the
   established pattern for privileged jobs is a secret-gated `/api/admin/*`
   route invoked manually.

---

## 2. Decision — Compute substrate: Vercel Sandbox (not the function directly)

**Decision:** Run the Agent SDK inside a `@vercel/sandbox` microVM, not directly
in the Next.js serverless function.

**Why:** The Agent SDK + its transitive native binaries are too large to bundle
into the request function, and running untrusted-ish agent execution in-process
gives it the function's ambient credentials and filesystem. The sandbox gives a
clean, disposable Linux VM with the correct native binary and no host secrets.
This was Rick's call going in and the spike confirmed the SDK footprint.

**Consequence:** every agent turn runs in a VM we provision. That provisioning
cost is the thing §3 exists to eliminate.

---

## 3. Decision — Cold-start: golden-snapshot lifecycle

**Decision:** Maintain a **golden snapshot** of a sandbox that already has the
agent dependencies installed. Boot every agent turn *from* that snapshot
(`Sandbox.create({ source: { type: "snapshot", snapshotId } })`), skipping
`npm install` entirely.

**Evidence:** warm boot measured at ~200 ms across 3 runs; the ~10 s install is
gone. This is what makes the whole approach interactive.

### 3a. Where the `snapshotId` lives — **DB column, not env var**

A snapshotId is operational state that changes when we rebuild (on a dep bump),
not a deploy-time secret. Env vars in this repo require a **redeploy** to change
(`CLAUDE.md`), which is wrong for a value a job regenerates at runtime.

The repo has **no generic config/KV table**; the established pattern is *typed
columns on the relevant model*, and the closest precedent is the SSO secret pair
`Workspace.ssoSecretEncrypted` + `ssoSecretUpdatedAt`
(`prisma/schema.prisma:120,125`).

- The golden snapshot is **deployment-global**, not per-workspace (the deps are
  identical for everyone). There is no app-global singleton table today.
- **Decision:** introduce a minimal singleton table
  `AgentRuntimeConfig` (one row) with `goldenSnapshotId String`,
  `snapshotBuiltAt DateTime`, and `depsFingerprint String` (a hash of the
  sandbox `package.json`). Follow the DSQL doctrine: **no FKs, no JSON columns,
  `updatedAt` set explicitly** (`prisma/migrations/019_scoring_models` notes).
  Rationale over a `Workspace` column: it's global, and a dedicated row keeps
  the rebuild job's read/write trivial and uncoupled from tenant data.

### 3b. How the snapshot gets (re)built — **secret-gated admin route, manual trigger**

There is **no cron/queue** in the repo; every privileged job is a
secret-gated `/api/admin/*` POST invoked by curl (`/api/admin/migrate`,
`/api/admin/repair-workspace-memberships`, …).

- **Decision:** add `POST /api/admin/rebuild-agent-snapshot`, gated by
  `MIGRATION_SECRET` (same trust boundary as `/api/admin/migrate`). It runs the
  spike's proven `?mode=build` logic (create → `npm install` →
  `session.snapshot()`), then writes the new `goldenSnapshotId` +
  `depsFingerprint` to `AgentRuntimeConfig`.
- **Trigger:** manual for v1, matching every other admin job. Run it after any
  change to the sandbox dependency set. A CI check can compare the sandbox
  `package.json` hash against the stored `depsFingerprint` and *warn* if they've
  drifted — but automating the rebuild would mean introducing the repo's first
  cron (`vercel.json`), explicitly **out of scope** for v1.
- **Retention/expiry:** use the SDK's first-class controls —
  `snapshotExpiration` and `keepLastSnapshots` (1–10). Keep the last ~3 so an
  in-flight turn booting the previous snapshot isn't killed mid-rebuild. Each
  snapshot is ~454 MB; budget storage accordingly.

### 3c. Secrets are never baked into a snapshot

The build step must **not** run the agent or set `ANTHROPIC_API_KEY` — secrets
are passed only at `runCommand` time on the warm path, so they never enter the
snapshot's filesystem/memory. (The spike route already enforces this split.)

> **Operational lesson to carry forward:** never request the Anthropic key into
> a Claude Code session under the bare name `ANTHROPIC_API_KEY` — it collides
> with Claude Code's own auth env var. Use a prefixed name
> (`COMPASS_ANTHROPIC_API_KEY`) and map it to `ANTHROPIC_API_KEY` only inside
> Compass's own env. In production it's simply a Vercel project env var.

---

## 4. Decision — Auth & data scoping (the crux, and the largest work item)

This is the decision that actually gates whether the feature is safe to ship.

### The situation the spike exposed

- **Per-user API keys already exist and are sound:** `ApiKey`
  (`prisma/schema.prisma:667-680`) — user-scoped (`userId`), secret stored as a
  SHA-256 `keyHash` with an 8-char `keyPrefix`, revocable via `revokedAt`, token
  format `cmp_<32 hex>`.
- **`validateMcpAuth` already returns identity:** service key →
  `{ valid, userId: null }`; per-user key → `{ valid, userId }`
  (`lib/mcp-auth.ts`).
- **BUT every MCP tool handler is unscoped.** `withMcpAuth` checks only
  `auth.valid` and **discards `userId`** (`app/api/mcp/route.ts:2183-2189`);
  handlers resolve targets purely from caller-supplied `orgSlug`/`workspaceId`
  with **no membership check** (`list_workspaces`, `get_workspace_by_slug`,
  `create_opportunity`, …). `lib/permissions.ts:12-14` states this is
  intentional: MCP tools deliberately skip the membership/role gates that
  session-based server actions enforce (`resolveWorkspace`,
  `resolveOrgAdmin`/`resolveWorkspaceAdmin`).

**Implication:** today, *any* valid bearer token — the service key **or any
user's personal key** — can read and write **every** org/workspace in the
database. An agent handed a user's key would therefore not be constrained to
that user's data. "Act as the user" is **not** a matter of issuing a key; it
requires adding per-user authorization to the MCP surface itself.

### Decision

1. **The agent authenticates as the acting user** via that user's `ApiKey`
   (`cmp_…`), minted on demand for the session, never the service-account
   `MCP_API_KEY`. The service key stays reserved for trusted server-to-server
   jobs.
2. **Thread `userId` through `/api/mcp` and enforce membership/role at the tool
   layer.** `withMcpAuth` must pass `auth.userId` into handlers; each handler
   (or a shared resolver) must apply the same membership scoping the UI already
   has — i.e. an MCP resolver analogous to `resolveWorkspace`
   (`members: { some: { userId } }`) and, for admin-only mutations, the
   `resolveWorkspaceAdmin`/`resolveOrgAdmin` role gates from
   `lib/permissions.ts`.
3. **This is a cross-cutting change to the entire MCP tool catalog, not a
   feature-local one**, and it is the single biggest and riskiest work item.
   It must land (with tests per tool) **before** the agent is exposed to real
   user data. Shipping the agent on the current unscoped MCP layer would be a
   cross-tenant data-access hole.
4. **Backward compatibility:** the service key must retain its current global,
   unscoped behavior (existing automations and the snapshot-build job depend on
   it). Scoping applies only when `userId !== null`. Encode this explicitly:
   `userId === null` ⇒ trusted/global; `userId !== null` ⇒ membership-scoped.

> This decision is deliberately the headline of the ADR. Everything else is
> derisked; this is the part that turns a working demo into a safe product.

---

## 5. Decision — Session granularity: fresh sandbox per turn

**Decision:** boot a **fresh sandbox from the golden snapshot for each agent
turn**, and stop it when the turn completes. Do **not** hold a persistent
sandbox per conversation for v1.

**Why:** ~200 ms warm boot makes per-turn provisioning effectively free, and a
fresh VM per turn gives the cleanest isolation (no cross-turn or cross-user
state bleed, no idle-VM lifecycle to manage). Conversation continuity lives in
Compass (message history in the DB + prompt assembly), not in a warm VM.

**Revisit if:** we later need in-VM working state across turns (e.g. a
long-lived scratch workspace or files the agent builds up) — then evaluate a
persistent per-conversation sandbox with an idle-timeout. Not needed for a
tool-driving chat agent.

---

## 6. Decision — Transport & UI

**Decision:** stream the agent turn to the browser over the existing
`ReadableStream`-on-`command.logs()` path proven in the spike. The client
renders incremental output; first token at ~2.2 s, then streamed.

- The route parses the SDK's structured message stream (`system` / `assistant`
  / tool-use / `result`) and forwards a **clean, typed event stream** to the
  client (e.g. SSE or the Vercel AI SDK stream protocol) rather than the raw
  `[agent:stdout]` JSON lines the spike dumps for debugging.
- **Auth for the chat route:** it's a normal logged-in surface, so it uses the
  **session** (NextAuth), *not* the spike's `MCP_API_KEY` bearer shortcut. The
  route derives the acting `userId` from the session and mints/uses that user's
  `ApiKey` for the sandbox's MCP calls (§4). Because it's session-authed, it
  does **not** need an `isPublicPath()` allowlist entry (contrast the spike
  route, which did).

---

## 7. Decision — MCP callback path & deployment protection

The sandbox calls back into Compass's `/api/mcp` over HTTP.

- **Production:** `compass.rbcodelabs.com` is not behind Vercel SSO, so the
  callback needs only the app-level bearer (`cmp_…` user key). No bypass secret.
- **Protected preview/branch deploys:** those sit behind Vercel's project-level
  deployment protection, a **separate** trust boundary from the app's own auth.
  The sandbox's outbound call needs an `x-vercel-protection-bypass` header there
  (threaded as `SPIKE_MCP_BYPASS_SECRET` in the spike). Keep this **preview-only
  and clearly named**; it must never be required in prod.

---

## 8. Consequences

**Positive**
- Interactive latency without granting sandboxed code any DB access.
- Zero business-logic duplication — the agent drives the real MCP catalog, so
  every tool improvement benefits the agent for free.
- Disposable per-turn VMs → strong isolation, trivial lifecycle.

**Costs / risks**
- **MCP authorization retrofit (§4) is the critical path** — a cross-cutting
  change across all tools, with per-tool tests, that must precede launch.
- **~454 MB per snapshot** and a manual rebuild step on dep bumps; a stale
  snapshot (deps drift) is a live failure mode → the `depsFingerprint` CI warn
  mitigates it.
- **No cron precedent** — snapshot rebuild is manual for v1. Acceptable, but
  it's operational toil until automated.
- **Per-turn LLM cost** (~$0.1 for a trivial turn in the spike) scales with
  usage; needs a budgeting/limits story before broad rollout.

---

## 9. Rollout plan

**Phase 1 — MCP authorization (blocking, no user-facing surface)**
Thread `userId` through `withMcpAuth`; add a membership-scoped MCP resolver and
role gates; make the service key explicitly the only "global" identity. Tests
per tool. *Nothing agent-facing ships until this is done.*

**Phase 2 — Snapshot lifecycle**
`AgentRuntimeConfig` table + migration (DSQL rules); `POST
/api/admin/rebuild-agent-snapshot` (build → persist id); productionize the warm
run path from the spike; CI dep-fingerprint warn.

**Phase 3 — Agent turn service**
A session-authed route that: assembles conversation context from the DB, mints
the acting user's `ApiKey`, boots a sandbox from the golden snapshot, runs the
turn with per-user MCP scoping, and streams a typed event stream out. Persist
messages + usage/cost.

**Phase 4 — Chat UI**
The in-app surface on top of the Phase 3 stream. Visual/UX design tracked
separately.

**Phase 5 — Guardrails**
Per-user/session rate + cost limits, tool-allowlist per surface, audit logging
of agent-initiated mutations.

---

## 10. Open questions

- **Tool allowlist:** does the agent get the *full* MCP catalog, or a curated
  subset per surface? (Mutations especially — do we gate `create_*`/`delete_*`
  behind confirmation?)
- **Cost controls:** where do per-user budgets live and what's the ceiling?
- **Model choice:** the spike used `claude-sonnet-5`; revisit per
  latency/cost/quality once real prompts exist. (Consult the `claude-api` skill
  for current model IDs/pricing before hardcoding.)
- **Conversation memory:** confirm DB-backed history + prompt assembly is
  sufficient, or whether we need summarization for long threads.
- **Rebuild automation:** when does manual snapshot rebuild become painful
  enough to justify the repo's first cron?

---

## Appendix — key evidence references

- Spike route + snapshot modes: `app/api/spike/agent-sandbox/route.ts`;
  entry script `scripts/spike/agent-sandbox-entry.ts`.
- Auth: `lib/mcp-auth.ts` (`validateMcpAuth`); `ApiKey`
  `prisma/schema.prisma:667-680`; unscoped gate
  `app/api/mcp/route.ts:2183-2189`; intentional-skip note
  `lib/permissions.ts:12-14`; session scoping precedent
  `resolveWorkspace` / `lib/permissions.ts` role gates.
- Storage precedents: `Workspace.ssoSecretEncrypted`/`ssoSecretUpdatedAt`
  (`prisma/schema.prisma:120,125`); singleton-per-scope
  `WorkspaceScoringConfig`; DSQL JSON-as-TEXT doctrine
  (`prisma/migrations/019_scoring_models`, `024_launch_tiers_checklists`).
- Admin-job pattern: `app/api/admin/migrate/route.ts` (secret-gated, manual).
- Full spike measurements: vault note
  `Claude/agent-sdk-sandbox-spike-2026-08-06.md`.
