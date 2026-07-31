/**
 * Seed e2e test data into the compass_dev schema.
 *
 * Creates a self-contained org/workspace/user that functional tests
 * operate against. All data lives under `e2e-test-org` so teardown can
 * safely delete it without touching real dev data.
 */
import pg from "pg";

export const E2E_ORG_SLUG = "e2e-test-org";
export const E2E_WORKSPACE_SLUG = "e2e-workspace";
export const E2E_USER_EMAIL = "dev@localhost.dev";

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

export async function seedE2E(pool: pg.Pool): Promise<SeedResult> {
  // ── User ──────────────────────────────────────────────────────────────────
  const { rows: [user] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".users (id, name, email, email_verified, created_at)
    VALUES (gen_random_uuid(), 'Dev User', $1, NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [E2E_USER_EMAIL]);

  // ── Organization ──────────────────────────────────────────────────────────
  const { rows: [org] } = await pool.query<{ id: string }>(`
    INSERT INTO "${S}".organizations (id, slug, name, created_at)
    VALUES (gen_random_uuid(), $1, 'E2E Test Org', NOW())
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `, [E2E_ORG_SLUG]);

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
