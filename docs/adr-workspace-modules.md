# ADR: Workspace modules replace product-feature environment flags

Status: **Proposed.** Approval is an event from the decision provider, not a line in this file.

Where this lives: Compass keeps its Architecture Decision Records in Compass Docs (child of "Architecture Decisions" in the
`rbcodelabs/compass` workspace) and `docs/decisions/` is pointer stubs only. This file is the in-repo design record that ships with the
change (like `docs/adr-saved-views.md`); the Compass Doc should be created from it and routed through `request_decision`.

## Context

Product features were gated by deployment-wide environment variables (`COMPASS_RESEARCH_CAPTURE_ENABLED`, `COMPASS_PM_INTERVIEW_ENABLED`,
the three research voice flags, `WORKSPACE_UPDATES_ENABLED`, `FOLLOWING_ENABLED`, `COMPASS_AGENTS_ENABLED`) plus one per-workspace
column (`Workspace.launchWorkflowEnabled`). Env flags are all-or-nothing for every workspace, need a redeploy to change, are invisible
to the people and agents they affect, and fail with a message nobody can act on. The trigger: an agent calling `create_research_study`
in production was told "Research capture is not enabled" because the deployment lacked `COMPASS_RESEARCH_CAPTURE_ENABLED=1`; neither the agent
nor a workspace admin could do anything about it.

## Decision

A **module** is a workspace-level capability a workspace administrator switches on or off in **Settings > Modules**.

1. **Registry in code** (`lib/modules/registry.ts`): key, label, description, `defaultEnabled`, `requires` (dependencies), group, and a
   `sensitive` marker. Nine modules: `research_capture`, `pm_interview`, `research_voice_authoritative`, `research_voice_browser`,
   `research_voice_discovery`, `workspace_updates`, `following`, `agents`, `launch_workflow`. Everything defaults **off**.
2. **Persisted state in `workspace_modules`** (migration 105): one row per `(workspace_id, module_key)` with `enabled`, `updated_by_user_id`,
   timestamps; a unique index on the pair. **No row means the registry default.**
3. **Server helper** (`lib/modules/server.ts`): `isModuleEnabled(workspaceId, key)`, `requireModule(workspaceId, key)` (throws
   `ModuleDisabledError`), `getWorkspaceModuleStates`, `describeModules`, `setWorkspaceModule`. Reads are cached per request with React `cache`.
4. **Control surfaces**: the Modules settings page and `setWorkspaceModuleEnabled` server action (workspace admin, `resolveWorkspaceAdmin`);
   MCP `list_workspace_modules` (members and delegated agents, read-only) and `update_workspace_module` (human workspace admin only, DENY for
   agent identities); REST `listWorkspaceModules` / `updateWorkspaceModule` for MCP/REST parity.
5. **The environment variables are removed** from the code and `.env.example`.

### Why a table and not a column

| Option | Verdict |
| --- | --- |
| A boolean column per module on `workspaces` | Rejected. Every new module needs a migration (the thing asked to avoid), and DSQL column adds are slow-path DDL. |
| One JSON/text column on `workspaces` | Rejected. No unique constraint, whole-blob read-modify-write races between two admins toggling different modules, no per-row `updated_by`/`updated_at`, and a hot, wide table gets wider. |
| **Key/value rows in `workspace_modules`** | **Chosen.** A new module is a registry entry: no migration. Toggling one module writes one row, so concurrent toggles of different modules cannot clobber each other. Per-row attribution. Same shape as `workspace_default_agents` (101), so it follows DSQL conventions already proven here (no FKs, find-then-write, async unique index, `updated_at` set in code). |

`module_key` is free text validated in application code against the registry. A stored key the code no longer knows is ignored on read.

### Dependencies

`requires` is enforced twice. On **read** it is fail-closed and transitive: a module is effective only if its stored/default value is on
**and** every requirement is effective, whatever its own row says. On **write**, enabling a module whose requirements are off is refused
with a message naming them (nothing is silently enabled on the admin's behalf, which matters for the voice modules), and disabling a module
also disables its dependents so stored state never claims "on" for something that cannot run. Voice: `research_voice_authoritative` and
`research_voice_browser` require `research_capture`; `research_voice_discovery` requires `research_voice_authoritative`.

### Voice stays fail-closed

The three voice modules default off and are `sensitive`. The previous semantics are kept as they were: participant voice is
`browser || legacyHarness`; discovery voice is `browser || (authoritative && discovery module)`. The legacy browser-authoritative
harness keeps its two runtime-environment guards in `lib/research-feature.ts` (`NODE_ENV !== "production"` **and** `E2E_FUNCTIONAL === "1"`)
on top of the authoritative-voice module; those are properties of a test-only transport, not product gating, so they stay environment
checks. The only NODE_ENV behaviour removed is "everything is on outside production": a non-production deployment now needs the modules
switched on like production does (local dev: Settings > Modules; e2e: the seed). Authoritative-voice call sites resolve the workspace
from the call/session (`call.session.study.workspaceId`) and treat an unresolvable session as disabled.

### Contexts with no workspace

| Site | Decision |
| --- | --- |
| Participant routes (`/api/research/*`, `/research/[token]`) | Resolve the workspace from the participant token's study. `findResearchTokenWorkspaceId` is a bare lookup used only to pick the workspace for the module check; the strict token resolvers still check status and expiry. |
| Voice worker callbacks | Bearer is bound to a voice call first; the call's session's study's workspace then decides. Invalid token stays 401; disabled workspace is 404 as before. |
| Generic mutation adapter (`captureWorkspaceMutation`) | The row it writes names its workspace, but only after the write. The transaction is opened when the Updates tables exist (as it already was in production) and the per-workspace `workspace_updates` / `following` decision is taken inside it, after the write. A write whose row (and, for updates, its prior row) names no workspace is not captured and is logged; it never fails the edit. |
| `mcp-auth` personal agent key and agent-bound OAuth token | No workspace at authentication. Valid only while **at least one workspace the agent holds a live grant in has `agents` on**; otherwise `{ valid: false }` (401, never a downgrade to USER). Every later request is narrowed to the granted workspaces that have it on (`agentWorkspaceWhere`), so a workspace that turned agents off is unreachable even if the agent authenticates through another. `AGENT_TURN` keys are workspace-scoped and use that workspace. This does not weaken authentication: the same agent/owner/status checks run, and the module check is additional narrowing. |
| Org admin capability grants, owner org-admin rights | Require the agent to be available in the actor's scoped workspace, or any workspace it is granted in. |
| "My agents" (account), OAuth consent screen, remembered consent | User-level. Enabled while any workspace the user belongs to has `agents` on. |
| Org settings agent access | Enabled while any workspace of the organization has `agents` on. |
| Nav in non-workspace layouts (account, org settings, org roadmap) | They anchor on one workspace for link targets; the nav reflects that workspace's modules. |

### Failure semantics

Unreadable state never turns a module on. The one tolerated failure is a **missing table** (Prisma `P2021`, migration 105 not applied): every
module then reads as its default (off), except `launch_workflow`, which falls back to the legacy `workspaces.launch_workflow_enabled` column,
so the launch surface keeps working through a deploy-then-migrate gap. Any other database error propagates.

### The launch workflow

`launch_workflow` is a module like the rest. The legacy column stays **readable and is mirrored on every toggle** (so a rollback to code that
still reads it sees the same answer) and is dropped by a follow-up. Migration 105 carries every workspace with the column on into a
`launch_workflow` row (insert-if-missing). The old settings action `updateLaunchWorkflowSettings` is removed: it only checked membership
and is replaced by the admin-gated Modules action.

## Rollout

Two registered migrations, applied through `/api/admin/migrate`:

* **105_workspace_modules** (DDL + launch carry-over, applied by the normal run). Idempotent. Postcondition proves the columns, the unique
  index, and that every workspace with the launch column on has a `launch_workflow` row.
* **106_workspace_modules_legacy_flag_backfill** (no DDL, **explicit-only**: an untargeted POST never runs it). Reads the **old environment
  flags at run time** and, for each that is exactly `"1"`, inserts an enabled row for every existing workspace that has no row for that
  module. Unset or other values write nothing. It never changes an existing row, never enables dependencies on a module's behalf, and
  never reproduces "on outside production". Idempotent.

Order: **apply the migrations, then promote the code.** Run 105 and 106 against the new deployment (a production-target build that has not
been promoted yet, or immediately after promotion if it cannot be staged) **while the old Vercel environment variables are still set**;
remove the variables only after 106 has a receipt and the readback matches. If the code is promoted first, modules read as off until 105 is
applied and 106 restores them (research, voice, updates, following and agents are unavailable for that window; the launch workflow keeps
working from the legacy column).

New workspaces start with every module off (previously the env flags were global, so a workspace created later inherited them). An admin
enables what the workspace needs.

## What stays environment configuration

Infrastructure, secrets and migration-mirror flags: `COMPASS_ENTITY_LINKS_*`, blob tokens, analytics keys, model credentials, etc.
`COMPASS_PASSKEYS_ENABLED` is **user/auth-level**, not workspace-level (the passkey provider is registered at the login screen, before any
workspace exists), so it is deliberately unchanged.

## Open questions for the owner

1. **Agent bootstrap.** An agent with no live grant in any workspace that has `agents` on can no longer authenticate, so it can no longer call
   `create_workspace` (previously a zero-grant agent could, with the owner's org-admin rights). A workspace created that way also starts with `agents`
   off, so the creating agent's automatic WRITE grant is inert until an admin enables the module there. This is deliberate fail-closed
   behaviour (no workspace is in scope to consult), not an oversight. Workaround: an admin enables Agents in one workspace and grants the agent
   there first. Alternatives if that is too strict: (a) let a zero-grant agent authenticate with an empty reach, (b) have `create_workspace` enable
   `agents` in the new workspace when the creator is an agent. Both widen what an agent can do on its own; neither is done here.
2. **New workspaces start with every module off**, where the env flags used to be inherited. Should workspace creation seed defaults (for example
   copy the creating workspace's modules)? Not done.
3. **Where this record lives.** `docs/decisions/` is pointer stubs only (repo rule), so this ADR is `docs/adr-workspace-modules.md` and still needs
   a Compass Docs record and `request_decision`.

## Consequences

* Adding a module is a registry entry (and the call sites that use it); no migration.
* Every gated feature is now decided per request per workspace; reads are one indexed query per workspace per request.
* Agents get an actionable error and a tool (`list_workspace_modules`) to find out why, but cannot enable a module themselves.
* An agent whose every granted workspace has `agents` off cannot authenticate at all, so it cannot call `list_workspace_modules`; the
  401 is the signal, and the fix is the same Settings > Modules switch.
* Follow-ups: drop `workspaces.launch_workflow_enabled`; consider per-module audit history if admins ask for it.
