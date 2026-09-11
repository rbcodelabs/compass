# ADR-0010: Live supporting Artifact links on Decisions

**Date:** 2026-09-09
**Status:** Accepted — user-approved Decision–Artifact implementation plan

## Context

A prototype URL in a Decision discussion is not discoverable in its structured
“Linked to” section. Review requests already have immutable revision packets and
recorded outcomes; Artifacts have independently replaceable revisions. Supporting
materials must be editable without implying that a prior approval covered their
current content.

The existing `ArtifactLink` table uses a string discriminator, a unique
`(artifactId, linkedType, linkedId)` key, and a workspace/type/target index.
It can represent this relationship without a migration or new dependency.

## Decision

Reuse `ArtifactLink` with `linkedType = REVIEW_REQUEST` and `linkedId` equal to
the stable request ID. Only requests with `gateType = TRACKED_DECISION` qualify.
These links are live supporting material, not review evidence snapshots.

- Keep the original subject and frozen Sources unchanged. Render linked Artifacts
  beneath the subject with title, current revision number, and archived status.
  Explain that their content is live and not frozen approval evidence.
- Link active same-workspace Artifacts from the Decision page. Existing archived
  links remain visible and removable. Show reciprocal Decision titles and unlink
  controls on Artifact detail; do not add a second creation picker there.
- Support pending and decided requests. Links follow the request across revisions
  and do not modify packets, fingerprints, request revision/cycle, or outcomes.
- Add `link_artifact_to_decision` and `unlink_artifact_from_decision`, each accepting
  `workspaceId`, `artifactId`, and `requestId`. Return stable IDs and a
  `created`/`removed` result using the standard structured MCP response. Extend
  both Decision getters with `artifacts`, and Artifact detail with `decisions`.
  Preserve existing Solution contracts; expose no private Blob metadata.
- Validate both targets within the declared workspace in shared operations.
  Linking is idempotent, including unique-key races; unlink uses scoped deletion
  with an idempotent result. Reject new links to archived Artifacts.
- Preserve the existing Artifact UI write boundary: workspace membership.
  Decision readers admitted solely by organization administration may see links
  but do not gain Artifact editing privileges. New server actions authenticate
  and enforce this boundary, independently of button visibility.
- Register both MCP mutations as writes and check `artifact` and `reviewRequest`
  through `assertChildInDeclaredWorkspace`. Reuse existing actor/source attribution
  and agent mutation auditing rather than adding a new audit schema.
- Fetch reciprocal titles with same-workspace filters and omit missing or
  ineligible targets. Invalidate both detail views after a mutation.
- Permanent Artifact deletion already removes all its links. Remove scoped
  `REVIEW_REQUEST` links before requests in workspace Decision cleanup, which
  currently runs before general Artifact cleanup. There is no individual request
  deletion API to extend. Retain links when either object's ordinary lifecycle
  changes without permanent deletion.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Reuse live `ArtifactLink` relationships (chosen) | Small additive surface; no migration; reciprocal navigation; matches approved intent | Application must enforce polymorphic integrity; content is not historically frozen |
| Add Artifact revision snapshots to review packets | Exact historical evidence | Requires packet/version changes and revision semantics; cannot provide freely editable supporting links without changing approval meaning |
| Keep comment URLs only | No implementation cost | Does not solve structured discoverability, reciprocal navigation, or MCP relationship readback |

## Consequences

Agents and humans can discover the same relationships through UI and MCP without
reopening a Decision. We deliberately give up treating those links as proof of
what a reviewer saw. A future requirement for frozen prototype approval needs a
separate evidence-snapshot design, not reinterpretation of these rows.

No automatic conversion of historical comment URLs is included. Rollback is a
code revert; retaining additive relationship rows preserves recoverability.

## Risks and Verification

The riskiest assumption is that users understand a live supporting link is not
immutable approval evidence. Verify the distinction in UI copy and docs, and
assert unchanged packet JSON, fingerprint, revision, cycle, outcome, and rationale
after link/unlink and Artifact revision replacement.

Polymorphic links have no database target foreign key. Exercise missing targets,
cross-workspace attempts, duplicate-link races, archive/removal behavior, and
workspace cleanup. Read paths must fail closed for dangling or foreign targets;
do not resolve an unscoped title from a stored target ID.

Test unauthenticated/UI membership boundaries and MCP read-only credentials in
addition to shared same-workspace validation. Check reciprocal refresh and the
full link → preview → backlink → unlink journey, including a decided request.
Verify desktop/mobile layouts, long titles, keyboard access, loading/errors, and
the existing Solution-link and packet v1/v2 behavior. No approval-authority or
global-role changes belong in this implementation.
