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
import {
  GUIDED_UX_SCREENSHOT_STUDY,
  GUIDED_UX_SCREENSHOT_TOKEN,
} from "../../screenshot-cases";

export const E2E_ORG_SLUG = "e2e-test-org";
export const E2E_WORKSPACE_SLUG = "e2e-workspace";
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
  nowCommitmentPolicy: object;
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

  const investmentFingerprint = createHash("sha256")
    .update(`e2e-building-investment:${ws.id}:${solutionId}`)
    .digest("hex");
  const { rows: [investmentRequest] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".review_requests
      (id, workspace_id, gate_type, subject_type, subject_id, state,
       revision_count, decision_cycle, requested_by_id, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'BUILDING_INVESTMENT', 'SOLUTION', $2,
            'DECIDED', 1, 1, $3, NOW(), NOW())
    RETURNING id
  `, [ws.id, solutionId, user.id]);
  const { rows: [investmentRevision] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".review_revisions
      (id, request_id, revision_number, fingerprint, title, summary,
       packet_json, required_role, created_at)
    VALUES (gen_random_uuid(), $1, 1, $2, 'Authorize E2E Building investment',
            'Seeded applied investment authority for the functional NOW gate.',
            $3, 'ADMIN', NOW())
    RETURNING id
  `, [investmentRequest.id, investmentFingerprint, JSON.stringify({ solutionId, outcome: "APPROVE_BUILDING" })]);
  await pool.query(`UPDATE "${S}".review_requests SET current_revision_id = $2 WHERE id = $1`, [investmentRequest.id, investmentRevision.id]);
  const { rows: [investmentOption] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".review_options
      (id, revision_id, action_key, label, outcome_class, continuation_key, sort_order, created_at)
    VALUES (gen_random_uuid(), $1, 'APPROVE_BUILDING', 'Approve Building investment',
            'APPROVE', 'AUTHORIZE_BUILDING_INVESTMENT', 0, NOW())
    RETURNING id
  `, [investmentRevision.id]);
  const investmentDecidedAt = "2026-08-31T12:00:00.000Z";
  const { rows: [investmentDecision] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".decision_records
      (id, workspace_id, request_id, revision_id, option_id, fingerprint,
       actor_user_id, actor_role, rationale, idempotency_key, decided_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'ADMIN',
            'Seeded E2E Building investment authority', $7,
            TIMESTAMP '2026-08-31 12:00:00.000')
    RETURNING id
  `, [ws.id, investmentRequest.id, investmentRevision.id, investmentOption.id, investmentFingerprint, user.id, `e2e-building:${solutionId}`]);
  const { rows: [investmentApplication] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".decision_applications
      (id, decision_id, continuation_key, target_type, target_id, status,
       receipt_key, attempt_count, applied_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, 'AUTHORIZE_BUILDING_INVESTMENT', 'SOLUTION',
            $2, 'APPLIED', $3, 1, NOW(), NOW(), NOW())
    RETURNING id
  `, [investmentDecision.id, solutionId, `e2e-building-authority:${solutionId}`]);

  const policyId = "e2e-native-now-policy-v1";
  const planFingerprint = createHash("sha256")
    .update(`e2e-capacity:${ws.id}:${policyId}:3`)
    .digest("hex");
  await pool.query(`DELETE FROM "${S}".portfolio_capacity_reservations WHERE plan_id IN (SELECT id FROM "${S}".portfolio_capacity_plans WHERE workspace_id = $1 AND policy_id = $2)`, [ws.id, policyId]);
  const { rows: [capacityPlan] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".portfolio_capacity_plans
      (id, workspace_id, policy_id, plan_fingerprint, unit, available_units,
       units_per_now_item, now_limit, state, version, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'FOCUS_SLOT', 3, 1, 3, 'ACTIVE', 0, NOW(), NOW())
    ON CONFLICT (workspace_id, policy_id) DO UPDATE SET
      plan_fingerprint = EXCLUDED.plan_fingerprint, unit = EXCLUDED.unit,
      available_units = EXCLUDED.available_units,
      units_per_now_item = EXCLUDED.units_per_now_item,
      now_limit = EXCLUDED.now_limit, state = 'ACTIVE', version = 0, updated_at = NOW()
    RETURNING id
  `, [ws.id, policyId, planFingerprint]);

  const authorityChecksum = createHash("sha256").update(JSON.stringify({
    authority: "COMPASS_NATIVE",
    decisionId: investmentDecision.id,
    workspaceId: ws.id,
    solutionId,
    revisionId: investmentRevision.id,
    optionId: investmentOption.id,
    fingerprint: investmentFingerprint,
    decidedAt: investmentDecidedAt,
    applicationId: investmentApplication.id,
    continuationKey: "AUTHORIZE_BUILDING_INVESTMENT",
  })).digest("hex");
  const nowCommitmentPolicy = {
    version: 1,
    workspaces: {
      [ws.id]: {
        portfolioPolicyId: policyId,
        capacity: {
          planId: capacityPlan.id,
          planFingerprint,
          unit: "FOCUS_SLOT",
          availableUnits: 3,
          requestedUnits: 1,
          unitsPerNowItem: 1,
          nowLimit: 3,
        },
        investmentDecisions: {
          [solutionId]: {
            authorityProvider: "COMPASS_NATIVE",
            authorityRecordId: investmentDecision.id,
            authorityChecksum,
            decisionOutcome: "APPROVE_BUILDING",
            applicationStatus: "APPLIED",
            applicationReceiptId: investmentApplication.id,
          },
        },
      },
    },
  };

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
  return { orgId: org.id, workspaceId: ws.id, userId: user.id, schema: S, nowCommitmentPolicy };
}
