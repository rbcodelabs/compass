/**
 * Seed e2e test data into the compass_dev schema.
 *
 * Creates a self-contained org/workspace/user that functional tests
 * operate against. All data lives under `e2e-test-org` so teardown can
 * safely delete it without touching real dev data.
 */
import pg from "pg";
import { createHash } from "node:crypto";
import { orgNameForToken } from "./run-token";
import { buildingInvestmentSourceFingerprint } from "../../../lib/building-investment";
import {
  GUIDED_UX_SCREENSHOT_STUDY,
  GUIDED_UX_SCREENSHOT_TOKEN,
} from "../../screenshot-cases";

export const E2E_ORG_SLUG = "e2e-test-org";
export const E2E_WORKSPACE_SLUG = "e2e-workspace";
export const E2E_SECOND_WORKSPACE_SLUG = "e2e-planning";
export const E2E_USER_EMAIL = "dev@localhost.dev";
export const E2E_NOW_CANDIDATE_TITLE = "E2E Native NOW Policy Candidate";

// Mirrors the production default target for "Send Feedback about Compass"
// (FEEDBACK_TARGET_ORG_SLUG / FEEDBACK_TARGET_WORKSPACE_SLUG), so the global
// feedback E2E spec can exercise that flow without env overrides. Unlike
// e2e-test-org, this org/workspace is NOT torn down wholesale after each
// run — it's meant to persist like its production counterpart — see
// global-teardown.ts for the narrower cleanup this requires.
export const COMPASS_META_ORG_SLUG = "rbcodelabs";
export const COMPASS_META_WORKSPACE_SLUG = "compass";

// Mirror what getActiveSchema() returns when NODE_ENV=development
const S = process.env.PGSCHEMA
  ? `${process.env.PGSCHEMA}_dev`
  : "compass_dev";

export type SeedResult = {
  orgId: string;
  workspaceId: string;
  userId: string;
  schema: string;
};

/**
 * @param runToken Stamped into the seeded org's `name` so global-teardown can
 *   prove the org it is about to delete belongs to *this* run. See
 *   fixtures/run-token.ts for why. Omit to keep the plain legacy name.
 */
export async function seedE2E(
  pool: pg.Pool,
  runToken?: string
): Promise<SeedResult> {
  // ── User ──────────────────────────────────────────────────────────────────
  const { rows: [user] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".users (id, name, email, email_verified, created_at)
    VALUES (gen_random_uuid(), 'Dev User', $1, NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [E2E_USER_EMAIL]);

  // ── Organization ──────────────────────────────────────────────────────────
  // The name doubles as this run's ownership stamp — the ON CONFLICT branch
  // deliberately overwrites it, so the most recent run to seed is the one
  // teardown will recognise as owner.
  const orgName = runToken ? orgNameForToken(runToken) : "E2E Test Org";
  const { rows: [org] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".organizations (id, slug, name, created_at)
    VALUES (gen_random_uuid(), $1, $2, NOW())
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [E2E_ORG_SLUG, orgName]);

  await pool.query(`
    INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (organization_id, user_id) DO NOTHING
  `, [org.id, user.id]);

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { rows: [ws] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".workspaces
      (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'E2E Workspace', false, false, NOW(), NOW())
    ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [org.id, E2E_WORKSPACE_SLUG]);

  await pool.query(`
    INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `, [ws.id, user.id]);

  // A second membership makes the marketing homepage exercise its workspace
  // selector instead of the single-workspace shortcut.
  const { rows: [secondWorkspace] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".workspaces
      (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'E2E Planning', false, false, NOW(), NOW())
    ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [org.id, E2E_SECOND_WORKSPACE_SLUG]);

  await pool.query(`
    INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `, [secondWorkspace.id, user.id]);

  // ── Deterministic guided UX screenshot fixture ──────────────────────────
  // This public token exists only in the disposable functional workspace.
  // Screenshot tests choose Chat but never start a session, so no paid model
  // or realtime provider is contacted.
  const screenshotTokenHash = createHash("sha256").update(GUIDED_UX_SCREENSHOT_TOKEN).digest("hex");
  const screenshotGuide = JSON.stringify([
    { id: "1", text: "Find the plan you would choose for a growing team." },
    { id: "2", text: "Compare the two plans that seem most relevant." },
    { id: "3", text: "Find out whether you can change plans later." },
    { id: "4", text: "Locate help for a question you still have." },
    { id: "5", text: "Explain what you would do next." },
  ]);
  const { rows: [screenshotStudy] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".research_studies
      (id, workspace_id, name, goal, study_type, guide, target_minutes, app_url,
       share_token_hash, share_expires_at, status, created_at, updated_at, created_by_id, source)
    VALUES
      (gen_random_uuid(), $1, $2,
       'Where people hesitate while choosing a plan for their team',
       'USABILITY_TEST', $3, 20, 'https://example.com/', $4, '2099-01-01',
       'ACTIVE', NOW(), NOW(), $5, 'UI')
    ON CONFLICT (share_token_hash) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      name = EXCLUDED.name,
      goal = EXCLUDED.goal,
      study_type = EXCLUDED.study_type,
      guide = EXCLUDED.guide,
      target_minutes = EXCLUDED.target_minutes,
      app_url = EXCLUDED.app_url,
      share_expires_at = EXCLUDED.share_expires_at,
      status = EXCLUDED.status,
      updated_at = NOW()
    RETURNING id
  `, [ws.id, GUIDED_UX_SCREENSHOT_STUDY, screenshotGuide, screenshotTokenHash, user.id]);
  await pool.query(`
    INSERT INTO "${S}".research_participant_tokens
      (id, study_id, token_hash, kind, expires_at, created_at, created_by_id)
    VALUES (gen_random_uuid(), $1, $2, 'PRIMARY', '2099-01-01', NOW(), $3)
    ON CONFLICT (token_hash) DO UPDATE SET
      study_id = EXCLUDED.study_id,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL
  `, [screenshotStudy.id, screenshotTokenHash, user.id]);

  // ── Baseline OKR cycle (tests create their own cycles on top) ─────────────
  await pool.query(`
    INSERT INTO "${S}".okr_cycles
      (id, workspace_id, title, status, start_date, end_date, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Cycle', 'ACTIVE',
           '2026-01-01', '2026-03-31', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".okr_cycles
      WHERE workspace_id = $1 AND title = 'E2E Baseline Cycle'
    )
  `, [ws.id]);

  // ── Native NOW policy fixture ────────────────────────────────────────────────────
  // The application verifies these rows at request time. Generate the policy
  // from freshly returned IDs instead of committing mutable database IDs.
  const { rows: [policyOpportunity] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".opportunities
      (id, workspace_id, title, status, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Native NOW Policy Opportunity', 'EXPLORING', 50, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".opportunities
      WHERE workspace_id = $1 AND title = 'E2E Native NOW Policy Opportunity'
    )
    RETURNING id
  `, [ws.id]);
  const opportunityId = policyOpportunity?.id ?? (await pool.query<{ id: string }>(`
    SELECT id FROM "${S}".opportunities
    WHERE workspace_id = $1 AND title = 'E2E Native NOW Policy Opportunity'
    ORDER BY created_at LIMIT 1
  `, [ws.id])).rows[0].id;

  const { rows: [policySolution] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".solutions
      (id, opportunity_id, title, status, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Native NOW Policy Solution', 'IN_DELIVERY', 0, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".solutions
      WHERE opportunity_id = $1 AND title = 'E2E Native NOW Policy Solution'
    )
    RETURNING id
  `, [opportunityId]);
  const solutionId = policySolution?.id ?? (await pool.query<{ id: string }>(`
    SELECT id FROM "${S}".solutions
    WHERE opportunity_id = $1 AND title = 'E2E Native NOW Policy Solution'
    ORDER BY created_at LIMIT 1
  `, [opportunityId])).rows[0].id;

  const { rows: [policySquad] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".squads (id, workspace_id, name, color, created_at)
    SELECT gen_random_uuid(), $1, 'E2E NOW Policy Squad', '#6366f1', NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".squads
      WHERE workspace_id = $1 AND name = 'E2E NOW Policy Squad'
    )
    RETURNING id
  `, [ws.id]);
  const squadId = policySquad?.id ?? (await pool.query<{ id: string }>(`
    SELECT id FROM "${S}".squads
    WHERE workspace_id = $1 AND name = 'E2E NOW Policy Squad'
    ORDER BY created_at LIMIT 1
  `, [ws.id])).rows[0].id;

  const { rows: [candidate] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".roadmap_items
      (id, workspace_id, squad_id, title, horizon, status, sort_order,
       solution_id, opportunity_id, now_commitment_provenance, created_at, updated_at)
    SELECT gen_random_uuid(), $1, $2, $3::varchar(255), 'NEXT', 'ACTIVE', 50,
           $4, $5, 'LEGACY_UNGATED', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".roadmap_items
      WHERE workspace_id = $1 AND title = $3::varchar(255)
    )
    RETURNING id
  `, [ws.id, squadId, E2E_NOW_CANDIDATE_TITLE, solutionId, opportunityId]);
  const candidateId = candidate?.id ?? (await pool.query<{ id: string }>(`
    UPDATE "${S}".roadmap_items
    SET squad_id = $2, horizon = 'NEXT', status = 'ACTIVE', solution_id = $3,
        opportunity_id = $4, now_commitment_provenance = 'LEGACY_UNGATED',
        now_decision_record_id = NULL, updated_at = NOW()
    WHERE workspace_id = $1 AND title = $5
    RETURNING id
  `, [ws.id, squadId, solutionId, opportunityId, E2E_NOW_CANDIDATE_TITLE])).rows[0].id;

  // Fixed copy and timestamps keep shared Discussion docs captures stable.
  const { rows: [discussionRoot] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".comments
      (id, workspace_id, target_type, target_id, body, status, author_id,
       author_name, author_type, source, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'ROADMAP_ITEM', $2,
      'Keep customer context attached to delivery.', 'OPEN', $3,
      'Dev User', 'HUMAN', 'UI', '2026-09-01 13:00:00', '2026-09-01 13:00:00')
    RETURNING id
  `, [ws.id, candidateId, user.id]);
  await pool.query(`
    INSERT INTO "${S}".comments
      (id, workspace_id, target_type, target_id, parent_id, body, status,
       author_id, author_name, author_type, source, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'ROADMAP_ITEM', $2, $3,
      'Agreed — the evidence should travel with the roadmap item.', 'OPEN',
      $4, 'Dev User', 'HUMAN', 'UI', '2026-09-01 13:05:00', '2026-09-01 13:05:00')
  `, [ws.id, candidateId, discussionRoot.id, user.id]);

  // Reset only this seeded authority chain so interrupted/retried runs remain
  // deterministic after the candidate has been admitted by a prior run.
  const priorRequests = await pool.query<{ id: string }>(`
    SELECT id FROM "${S}".review_requests
    WHERE workspace_id = $1 AND gate_type IN ('BUILDING_INVESTMENT', 'NOW_COMMITMENT')
      AND ((subject_type = 'SOLUTION' AND subject_id = $2)
        OR (subject_type = 'ROADMAP_ITEM' AND subject_id = $3))
  `, [ws.id, solutionId, candidateId]);
  const priorRequestIds = priorRequests.rows.map(({ id }) => id);
  if (priorRequestIds.length > 0) {
    await pool.query(`DELETE FROM "${S}".portfolio_capacity_reservations WHERE roadmap_item_id = $1`, [candidateId]);
    await pool.query(`DELETE FROM "${S}".decision_applications WHERE decision_id IN (SELECT id FROM "${S}".decision_records WHERE request_id = ANY($1::uuid[]))`, [priorRequestIds]);
    await pool.query(`DELETE FROM "${S}".decision_records WHERE request_id = ANY($1::uuid[])`, [priorRequestIds]);
    await pool.query(`UPDATE "${S}".review_requests SET current_revision_id = NULL WHERE id = ANY($1::uuid[])`, [priorRequestIds]);
    await pool.query(`DELETE FROM "${S}".review_options WHERE revision_id IN (SELECT id FROM "${S}".review_revisions WHERE request_id = ANY($1::uuid[]))`, [priorRequestIds]);
    await pool.query(`DELETE FROM "${S}".review_revisions WHERE request_id = ANY($1::uuid[])`, [priorRequestIds]);
    await pool.query(`DELETE FROM "${S}".review_requests WHERE id = ANY($1::uuid[])`, [priorRequestIds]);
  }

  const { rows: [investmentRequest] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".review_requests
      (id, workspace_id, gate_type, subject_type, subject_id, state,
       revision_count, decision_cycle, requested_by_id, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'BUILDING_INVESTMENT', 'SOLUTION', $2,
            'DECIDED', 1, 1, $3, NOW(), NOW())
    RETURNING id
  `, [ws.id, solutionId, user.id]);
  const { rows: [investmentSolution] } = await pool.query<{
    id: string; title: string; description: string | null; status: string; updated_at_utc: string;
    opportunity_id: string; opportunity_title: string; workspace_id: string;
  }>(`
    SELECT s.id, s.title, s.description, s.status,
           to_char(s.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc,
           o.id AS opportunity_id, o.title AS opportunity_title, o.workspace_id
    FROM "${S}".solutions s JOIN "${S}".opportunities o ON o.id = s.opportunity_id
    WHERE s.id = $1
  `, [solutionId]);
  const investmentSourceFingerprint = buildingInvestmentSourceFingerprint({
    id: investmentSolution.id, title: investmentSolution.title, description: investmentSolution.description,
    status: investmentSolution.status, updatedAt: new Date(investmentSolution.updated_at_utc),
    opportunity: { id: investmentSolution.opportunity_id, title: investmentSolution.opportunity_title, workspaceId: investmentSolution.workspace_id },
  });
  const investmentFingerprint = createHash("sha256")
    .update(`${investmentRequest.id}:1:1:${investmentSourceFingerprint}`)
    .digest("hex");
  const { rows: [investmentRevision] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".review_revisions
      (id, request_id, revision_number, fingerprint, source_fingerprint, title, summary,
       packet_json, required_role, created_at)
    VALUES (gen_random_uuid(), $1, 1, $2, $3, 'Authorize E2E Building investment',
            'Seeded applied investment authority for the functional NOW gate.',
            $4, 'ADMIN', NOW())
    RETURNING id
  `, [investmentRequest.id, investmentFingerprint, investmentSourceFingerprint, JSON.stringify({ solutionId, outcome: "APPROVE_BUILDING" })]);
  await pool.query(`UPDATE "${S}".review_requests SET current_revision_id = $2 WHERE id = $1`, [investmentRequest.id, investmentRevision.id]);
  const { rows: [investmentOption] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".review_options
      (id, revision_id, action_key, label, outcome_class, continuation_key, sort_order, created_at)
    VALUES (gen_random_uuid(), $1, 'APPROVE_BUILDING', 'Approve Building investment',
            'APPROVE', 'AUTHORIZE_BUILDING_INVESTMENT', 0, NOW())
    RETURNING id
  `, [investmentRevision.id]);
  const { rows: [investmentDecision] } = await pool.query<{ id: string; decided_at_utc: string }>(`
    INSERT INTO "${S}".decision_records
      (id, workspace_id, request_id, revision_id, option_id, fingerprint,
       actor_user_id, actor_role, rationale, idempotency_key, decided_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'ADMIN',
            'Seeded E2E Building investment authority', $7,
            TIMESTAMP '2026-08-31 12:00:00.000')
    RETURNING id, to_char(decided_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at_utc
  `, [ws.id, investmentRequest.id, investmentRevision.id, investmentOption.id, investmentFingerprint, user.id, `e2e-building:${solutionId}`]);
  await pool.query(`
    INSERT INTO "${S}".decision_applications
      (id, decision_id, continuation_key, target_type, target_id, status,
       receipt_key, attempt_count, applied_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'AUTHORIZE_BUILDING_INVESTMENT', 'SOLUTION',
            $2, 'APPLIED', $3, 1, NOW(), NOW(), NOW())
    RETURNING id
  `, [investmentDecision.id, solutionId, `e2e-building-authority:${solutionId}`]);

  // ── Baseline opportunity ──────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO "${S}".opportunities
      (id, workspace_id, title, status, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Opportunity', 'EXPLORING', 0, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".opportunities
      WHERE workspace_id = $1 AND title = 'E2E Baseline Opportunity'
    )
  `, [ws.id]);

  // ── Baseline experiment ────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO "${S}".experiments
      (id, workspace_id, title, hypothesis, method, kill_condition,
       status, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), $1,
           'E2E Baseline Experiment',
           'Baseline hypothesis for seeded experiment',
           'Baseline method',
           'Baseline kill condition',
           'DESIGNING', 0, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".experiments
      WHERE workspace_id = $1 AND title = 'E2E Baseline Experiment'
    )
  `, [ws.id]);

  // ── Baseline task ──────────────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO "${S}".tasks
      (id, workspace_id, title, status, priority, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Task', 'TODO', 'MEDIUM', 0, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".tasks
      WHERE workspace_id = $1 AND title = 'E2E Baseline Task'
    )
  `, [ws.id]);

  // ── "Send Feedback about Compass" target org/workspace ───────────────────
  // Owned by the same seeded user, so no separate login is needed to view
  // feedback that lands here via the global dialog.
  const { rows: [metaOrg] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".organizations (id, slug, name, created_at)
    VALUES (gen_random_uuid(), $1, 'RB Code Labs', NOW())
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [COMPASS_META_ORG_SLUG]);

  await pool.query(`
    INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (organization_id, user_id) DO NOTHING
  `, [metaOrg.id, user.id]);

  const { rows: [metaWs] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".workspaces
      (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'Compass', false, false, NOW(), NOW())
    ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [metaOrg.id, COMPASS_META_WORKSPACE_SLUG]);

  await pool.query(`
    INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `, [metaWs.id, user.id]);

  console.log(
    `[e2e seed] schema=${S} org=${org.id} ws=${ws.id} user=${user.id} metaOrg=${metaOrg.id} metaWs=${metaWs.id}`
  );
  return { orgId: org.id, workspaceId: ws.id, userId: user.id, schema: S };
}
