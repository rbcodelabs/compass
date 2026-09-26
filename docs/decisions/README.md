# docs/decisions — pointer stubs only

> **Do not add files to this directory.**
>
> Compass Docs is the authoritative home for Compass Architecture Decision
> Records. Create a new architecture decision as a child Doc of
> [**Architecture Decisions**](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/57218788-1db1-4148-b954-b98fb7055c62) in the `rbcodelabs/compass`
> workspace, then route it for approval with `request_decision` using
> `subjectType: "DOC"`.
>
> Never mark your own record "Accepted". Approval is an event that comes back
> from the configured decision provider — not a line you type.

## Why this directory still exists

The 16 ADRs that used to live here were migrated to Compass on **2026-09-19**.
Their files remain, reduced to short pointer stubs, because roughly 85 places in
this repo reference them by path — including source comments in
`app/api/mcp/route.ts`, `app/[orgSlug]/[workspaceSlug]/settings/actions.ts`,
`app/api/agent/turn/route.ts`, and `app/api/research/analysis/route.ts`, some of
which cite specific sections. Keeping the filenames keeps those references
resolving. Each stub names the decision and links to the real record.

This directory was never a documented convention — it had no backing in
`CLAUDE.md`, `.claude/pr-guidelines.md`, or `CONTRIBUTING.md`. It became a
pattern trap: an agent looking for precedent found 16 tidy sequentially-numbered
files and continued the pattern instead of consulting the configured routing
(`Products/Compass/pm-config.md`, which routes both `review_requests` and
`decision_records` to the `compass_decisions` provider). That is the behaviour
this README exists to stop.

**It caught two more agents while this PR sat open and unmerged.** ADR 0016
("Workspace Updates and Explicit Catch-up State", PR #284, 2026-09-24) was
committed here as a full file, the same mistake ADR 0014 made — because with
this PR unmerged, the directory still looked like 16 tidy files to follow. It
has now been migrated to Compass and stubbed below. Separately, the draft for
what became ADR 0017 (Compass GitHub App) was also first written to this
directory before being moved to Compass directly; it never merged here, so
there is no stub for it. Both are additional evidence the directory itself
was the trap, not any one agent's judgment.

## Index

| Stub | Decision |
|---|---|
| [`0001-in-app-agent-architecture.md`](./0001-in-app-agent-architecture.md) | [ADR 0001 — In-App Agent Architecture](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/b32030c8-100d-43a1-b74e-ed85a84c6f7e) |
| [`0002-consolidate-helio-into-compass.md`](./0002-consolidate-helio-into-compass.md) | [ADR 0002 — Consolidate Helio Research Capture into Compass](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/72c9dbe6-9201-4e72-a2e4-4fff873c13d3) |
| [`0002-solution-status-mcp-mutation.md`](./0002-solution-status-mcp-mutation.md) | [ADR 0002 — Dedicated MCP Mutation for Solution Lifecycle Status](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/50e648e4-77db-4959-97a2-54d3c702df33) |
| [`0003-compass-native-guided-ux.md`](./0003-compass-native-guided-ux.md) | [ADR 0003 — Compass-Native Guided UX with Chat and Realtime Voice](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/f3a56473-ed48-4fbf-b4aa-a91bdeaa1066) |
| [`0005-compass-native-decision-gates.md`](./0005-compass-native-decision-gates.md) | [ADR 0005 — Compass-Native Decision Gates and Immutable Decision Ledger](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/afff34a1-0eac-445d-88b8-471d52c674e3) |
| [`0006-expand-first-decision-authority.md`](./0006-expand-first-decision-authority.md) | [ADR 0006 — Expand-First Decision Authority and Generated Policy Artifacts](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/285a1491-2938-4fd5-8cd7-7e7b748e1d6b) |
| [`0007-shared-comments-and-decisions.md`](./0007-shared-comments-and-decisions.md) | [ADR 0007 — Shared Comments and Decision Boundaries](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/a5427837-d6a8-4455-8f9b-5ef9ed95eb38) |
| [`0008-authenticated-preview-validation.md`](./0008-authenticated-preview-validation.md) | [ADR 0008 — Authenticated Preview Validation](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/dc9a5c3e-4ae4-4717-870b-de346bd2b77e) |
| [`0008-declarative-agent-capability-packs.md`](./0008-declarative-agent-capability-packs.md) | [ADR 0008 — Declarative Agent Capability Packs](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/8c4c34a3-c919-4411-87f7-7cab7db40e35) |
| [`0009-human-and-agent-task-assignment.md`](./0009-human-and-agent-task-assignment.md) | [ADR 0009 — Personal Agents and Task Assignment](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/d0354138-d4da-4b67-b549-1cfc4c3c6cbb) |
| [`0009-preview-login.md`](./0009-preview-login.md) | [ADR 0009 — Preview Login for Human Exploration](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/fed755a0-0731-4c1b-a197-aa3b7951aa4d) |
| [`0010-live-decision-artifact-links.md`](./0010-live-decision-artifact-links.md) | [ADR 0010 — Live Supporting Artifact Links on Decisions](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/0c29c741-adea-4195-bce3-cfec15539f0b) |
| [`0011-pm-gather-flesh-out.md`](./0011-pm-gather-flesh-out.md) | [ADR 0011 — Authenticated PM Gather Interviews over the Research Session Engine](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/7da6f57b-aacd-4c7c-bf49-04082b36930c) |
| [`0012-research-processing-in-the-core-agent.md`](./0012-research-processing-in-the-core-agent.md) | [ADR 0012 — Research Processing in the Core Agent](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/a8190aa6-bebf-4287-b360-7c64a3443c40) |
| [`0013-custom-field-value-mcp-management.md`](./0013-custom-field-value-mcp-management.md) | [ADR 0013 — MCP Read/Write Access to Custom Field Values](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/47540dc3-6d32-42bf-a656-aa2d6431585d) |
| [`0014-compass-is-its-own-oauth-authorization-server.md`](./0014-compass-is-its-own-oauth-authorization-server.md) | [ADR 0014 — Compass Is Its Own OAuth Authorization Server](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/99822ac1-19dc-4399-9af1-98bdc9350064) |
| [`0015-agent-scoped-oauth-tokens.md`](./0015-agent-scoped-oauth-tokens.md) | [ADR 0015 — Agent-Scoped OAuth Tokens](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/5a9b08d8-3426-4045-ba2f-a5a466a0e5f5) |
| [`0016-workspace-updates-catch-up.md`](./0016-workspace-updates-catch-up.md) | [ADR 0016 — Workspace Updates and Explicit Catch-up State](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/a6c1a3df-67a6-4775-b34b-c6ecab3bbea9) |

Not an ADR, migrated separately to a root-level Compass doc:
[`research-guided-chat-parity-plan.md`](./research-guided-chat-parity-plan.md).

Never had a repo file (written directly to Compass): [ADR 0016 — Membership-Scoped
Read Resolver for Cross-Workspace Views](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/23133262-1ef0-4ea7-aa93-aff97fe44631)
and [ADR 0017 — Compass GitHub App](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/ff39bdf0-9b04-4f3f-aace-26575cfdfb32).

## Numbering is broken — on purpose, preserved

The original numbering had collisions and a gap. They were **not** renumbered,
because existing citations depend on the numbers as-is:

- **0002** — two unrelated ADRs (Helio consolidation; Solution-status MCP mutation)
- **0004** — does not exist in this repo (ADR 0005's "Obsidian ADR-0004" is a vault-side document)
- **0008** — two unrelated ADRs (Authenticated Preview Validation; Declarative Agent Capability Packs)
- **0009** — two unrelated ADRs (Personal Agents and Task Assignment; Preview Login)
- **0016** — two unrelated ADRs (Membership-Scoped Read Resolver; Workspace Updates
  catch-up), added independently by two later PRs with no repo copy of each
  other to notice the clash against

A citation of "ADR-0008", "ADR-0009" or "ADR-0016" is therefore ambiguous on
the number alone — check the subject.
