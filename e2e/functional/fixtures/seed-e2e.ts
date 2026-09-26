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

  // An interrupted prior run may have left observations and encrypted fixture
  // credentials. Only this just-claimed test organization's workspaces qualify.
  for (const table of ["metric_observations", "metric_bindings", "metric_revisions", "metric_definitions", "analytics_connections", "workspace_activation_states"]) {
    await pool.query(`DELETE FROM "${S}"."${table}" WHERE workspace_id IN (SELECT id FROM "${S}".workspaces WHERE organization_id = $1)`, [org.id]);
  }

  // ── Workspace ─────────────────────────────────────────────────────────────
  const { rows: [ws] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".workspaces
      (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
    VALUES (COALESCE($3::uuid, gen_random_uuid()), $1, $2, 'E2E Workspace', false, false, NOW(), NOW())
    ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [org.id, E2E_WORKSPACE_SLUG, process.env.GEODE_DOCS_PILOT_WORKSPACE_ID || null]);
  if (process.env.GEODE_DOCS_PILOT_WORKSPACE_ID && ws.id !== process.env.GEODE_DOCS_PILOT_WORKSPACE_ID) throw new Error("Pilot fixture workspace ID conflicts with existing seed");

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

  // ── Workspace search fixtures ────────────────────────────────────────────
  const { rows: [baselineOpportunity] } = await pool.query<{ id: string }>(`
    SELECT id FROM "${S}".opportunities
    WHERE workspace_id = $1 AND title = 'E2E Baseline Opportunity'
    ORDER BY created_at LIMIT 1
  `, [ws.id]);
  await pool.query(`
    INSERT INTO "${S}".solutions
      (id, opportunity_id, title, status, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Solution', 'IDEA', 0, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".solutions
      WHERE opportunity_id = $1 AND title = 'E2E Baseline Solution'
    )
  `, [baselineOpportunity.id]);
  await pool.query(`
    INSERT INTO "${S}".roadmap_items
      (id, workspace_id, title, horizon, status, sort_order, now_commitment_provenance, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Roadmap', 'LATER', 'ACTIVE', 0, 'LEGACY_UNGATED', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".roadmap_items
      WHERE workspace_id = $1 AND title = 'E2E Baseline Roadmap'
    )
  `, [ws.id]);
  await pool.query(`
    INSERT INTO "${S}".feedback
      (id, workspace_id, title, type, status, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Feedback', 'IDEA', 'OPEN', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".feedback
      WHERE workspace_id = $1 AND title = 'E2E Baseline Feedback'
    )
  `, [ws.id]);
  await pool.query(`
    INSERT INTO "${S}".docs
      (id, workspace_id, title, content, sort_order, doc_type, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Baseline Doc', 'Search fixture', 0, 'STANDARD', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".docs
      WHERE workspace_id = $1 AND title = 'E2E Baseline Doc'
    )
  `, [ws.id]);
  await pool.query(`
    INSERT INTO "${S}".docs
      (id, workspace_id, title, content, sort_order, doc_type, created_at, updated_at)
    SELECT gen_random_uuid(), $1, 'E2E Foreign Search Sentinel', 'Must never cross workspace boundaries', 0, 'STANDARD', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM "${S}".docs
      WHERE workspace_id = $1 AND title = 'E2E Foreign Search Sentinel'
    )
  `, [secondWorkspace.id]);

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
