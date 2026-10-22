# entity_links phase 6: ArtifactLink (Artifact -> Solution, Artifact -> Decision)

Runbook for migration `096_entity_links_backfill_artifact` (ADR "One generic entity_links table", phase 6). Nothing here applies
anything by itself.

## What ships

- Two registry types: `ARTIFACT_ATTACHED_TO_SOLUTION` (`artifact_links.linked_type = SOLUTION`) and `ARTIFACT_SUPPORTS_DECISION`
  (`linked_type = REVIEW_REQUEST`). Origin is always `DIRECT`; source, actor and created_at are copied from the legacy row.
- The Decision type keeps the legacy rule: only `TRACKED_DECISION` review requests take a link (registry `eligible` hook; any other gate
  type is "not found"). It is live supporting material per ADR-0010: the link names the Artifact, never a revision, and implies nothing
  about which revision an approval covered. The "no NEW link for an archived Artifact" rule stays in `lib/artifacts.ts` (the legacy
  writer), because the mirror hook also runs for the idempotent replay of an existing link.
- A dual-write mirror in `lib/artifacts.ts` / `lib/links/legacy-mirror.ts`, in the same transaction as the legacy write (the link and
  unlink functions now run in `runTypedLinkTransaction`, so a lost pair race re-runs the transaction instead of catching P2002 inside it),
  behind `COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR` (off in production unless `1`). `artifact_links` remains the source of truth; reads
  (`getDecisionArtifacts`, `getArtifactDecisions`, the Solution panel) and the generic link tools ignore both types. Removal never depends on
  the flag: the unlink half, the Artifact delete sweep and the workspace cascade run whatever it says.
- The explicit-only data migration `096` (no DDL). An untargeted POST never runs it.

## Order of operations (each production step needs the owner's explicit yes)

1. Run `entity-links-artifact-preflight.psql` (read-only) and read the counts and expected orphans. After the code is deployed the same numbers are
   in `GET /api/admin/migrate` under `entityLinksArtifactBackfill` (counts and capped ids only).
2. Decide who resolves quarantined rows (see below). 096 never links, changes or deletes them.
3. Confirm migration 091 (entity_links) is applied (GET `appliedMigrations`; 096 refuses without 034, 068 and 091). Deploy the code, set
   `COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR=1`, redeploy so every instance mirrors.
4. Pick a quiet window, then `GET /api/admin/migrate`, `POST /api/admin/migrate` with `{"script":"096_entity_links_backfill_artifact"}`, the
   status GET again, and an application-level readback (the response log lists the quarantined ids).
5. Rollback is the flag: set it off and nothing new is written or read. The mirror rows are inert without readers.

## Quarantine

Legacy rows that are not mirrored, by class: `invalidType` (linked_type is neither SOLUTION nor REVIEW_REQUEST), `dangling` (the Artifact or the
target is gone), `crossWorkspace` (Artifact and target in different workspaces, or a Solution with no workspace_id), `linkWorkspaceDrift` (the link row's
workspace differs from the Artifact's), `notTrackedDecision` (a REVIEW_REQUEST target whose gate_type is not TRACKED_DECISION). They are left untouched and
reported on every run; the postconditions allow them only because they are reported. A mirror row whose legacy row is quarantined is KEPT, never deleted, and
reported separately as `mirrorRowsKeptForQuarantine` (count plus capped entity_links ids).

## Residual pass

Re-POSTing 096 does nothing once its receipt exists: the runner only selects PENDING migrations (`selectMigrationsToRun` ignores applied ones).
096's hook re-selects from `artifact_links` (prunes mirror rows with no legacy counterpart, repairs workspace/origin drift, inserts what is
missing, then proves the postconditions), but only an unfinished attempt resumes. If the read flip needs a re-run after the mirror has been
live, register a separately numbered, DDL-free, explicit-only residual that calls `backfillEntityLinksArtifact` and
`assertEntityLinksArtifactBackfill` (the 072/094 pattern, as `106_entity_links_residual_opportunity` does for Opportunity). It is not built
here because nothing yet calls for it.

## Known mirror gaps the backfill covers

- A Solution delete drains `entity_links` rows by endpoint on a best-effort basis after the parent delete (logged and swallowed on failure, like
  phases 4 and 5); the legacy `artifact_links` rows for a deleted Solution are not touched by that path. A failed drain leaves a mirror row 096 prunes
  or keeps-and-reports.
- Changes made while the flag is off are not mirrored; 096 repairs them. With the flag off, unlink and delete sweeps still remove mirror rows.
- A live writer inserting a pair between 096's select and insert makes the unique index refuse that batch; the hook re-selects (bounded), and a
  re-POST resumes anyway.

## Read flag and read parity (entity_links read flip)

`COMPASS_ENTITY_LINKS_ARTIFACT_READ` = `off | shadow | on` decides how readers treat `ARTIFACT_ATTACHED_TO_SOLUTION` and `ARTIFACT_SUPPORTS_DECISION` (a decision link counts only while the review request is a TRACKED_DECISION). Fail-closed: only the exact strings `shadow` and `on` count (in production
exactly; elsewhere trimmed and case-insensitive), anything else, including unset, is `off`, and unlike the `*_MIRROR` flag there is no
default-on outside production. Semantics: `off` reads the legacy table only; `shadow` serves the legacy result and compares it with
`entity_links` (counts and ids only, never content), `on` serves `entity_links`. Rollback is always the flag set to `off`. The flag moves
`LegacyAdapter.mode` from `mirror` to `shadow` / `read` (`effectiveLegacyMode` in `lib/links/registry.ts`).

This change ships the flag, the comparator (`lib/links/read-compare.ts`) and the status below, and routes NO reader through them yet, so setting
the flag changes nothing until the reader PR for this family lands.

`GET /api/admin/migrate` reports `entityLinksReadParity` (read-only, counts and ids capped at 20): the read modes, `totalMismatches`, and per
type `legacyLive`, `mirrorLive`, `onlyLegacy` (a flipped reader would hide the link), `onlyEntityLinks` (it would show an extra link) and
`originDrift`. "Live" means both endpoints exist in the link's workspace, i.e. what the workspace-filtered readers show, so quarantined
rows (dangling, cross-workspace) are absent on both sides. Cost: one scan of the legacy table plus the mirror rows of the family's types
(`entity_links` has no index that leads with `link_type`); poll sparingly. Require zero mismatches (or an explained, repaired cause) before
setting the flag to `on`. Types in this family: `artifactSolution`, `artifactDecision`.
