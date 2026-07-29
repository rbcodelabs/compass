/**
 * Playwright globalTeardown — runs after all functional tests complete.
 * Triggered only when E2E_FUNCTIONAL=1 is set (see playwright.config.ts).
 *
 * Deletes all data under the e2e-test-org, in reverse dependency order
 * to satisfy manual FK constraints (relationMode="prisma" = no DB cascades).
 *
 * Set E2E_SKIP_TEARDOWN=1 to skip cleanup after a test failure,
 * so you can inspect the DB state and re-run individual tests.
 */
import path from "path";
import pg from "pg";
import { E2E_ORG_SLUG } from "./fixtures/seed-e2e";

const S = process.env.PGSCHEMA
  ? `${process.env.PGSCHEMA}_dev`
  : "compass_dev";

export default async function globalTeardown() {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  } catch {
    // .env.local may not exist in CI
  }

  if (process.env.E2E_SKIP_TEARDOWN) {
    console.log("[e2e teardown] Skipped (E2E_SKIP_TEARDOWN is set)");
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[e2e teardown] DATABASE_URL not set — skipping cleanup");
    return;
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "${S}".organizations WHERE slug = $1`,
      [E2E_ORG_SLUG]
    );
    if (!rows[0]) {
      console.log("[e2e teardown] e2e org not found — nothing to clean");
      return;
    }
    const orgId = rows[0].id;

    const { rows: wsRows } = await pool.query<{ id: string }>(
      `SELECT id FROM "${S}".workspaces WHERE organization_id = $1`,
      [orgId]
    );

    for (const { id: wsId } of wsRows) {
      // ── Delete in strict dependency order (no DB-level cascades) ──────────

      // check_ins → key_results → objectives → okr_cycles
      await pool.query(
        `DELETE FROM "${S}".check_ins
         WHERE key_result_id IN (
           SELECT id FROM "${S}".key_results
           WHERE objective_id IN (
             SELECT id FROM "${S}".objectives
             WHERE cycle_id IN (
               SELECT id FROM "${S}".okr_cycles WHERE workspace_id = $1
             )
           )
         )`,
        [wsId]
      );

      // experiment_results → experiments
      await pool.query(
        `DELETE FROM "${S}".experiment_results
         WHERE experiment_id IN (
           SELECT id FROM "${S}".experiments WHERE workspace_id = $1
         )`,
        [wsId]
      );

      // assumptions → solutions → opportunities
      await pool.query(
        `DELETE FROM "${S}".assumptions
         WHERE solution_id IN (
           SELECT id FROM "${S}".solutions
           WHERE opportunity_id IN (
             SELECT id FROM "${S}".opportunities WHERE workspace_id = $1
           )
         )`,
        [wsId]
      );

      // roadmap_items
      await pool.query(
        `DELETE FROM "${S}".roadmap_items WHERE workspace_id = $1`,
        [wsId]
      );

      // canvas_node_positions — table exists even though Phase 1 never
      // writes to it (no drag-to-pin UI yet), needed once Phase 2 starts.
      await pool.query(
        `DELETE FROM "${S}".canvas_node_positions WHERE workspace_id = $1`,
        [wsId]
      );

      // key_results → objectives → okr_cycles
      await pool.query(
        `DELETE FROM "${S}".key_results
         WHERE objective_id IN (
           SELECT id FROM "${S}".objectives
           WHERE cycle_id IN (
             SELECT id FROM "${S}".okr_cycles WHERE workspace_id = $1
           )
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".objectives
         WHERE cycle_id IN (
           SELECT id FROM "${S}".okr_cycles WHERE workspace_id = $1
         )`,
        [wsId]
      );

      // solutions → opportunities
      await pool.query(
        `DELETE FROM "${S}".solutions
         WHERE opportunity_id IN (
           SELECT id FROM "${S}".opportunities WHERE workspace_id = $1
         )`,
        [wsId]
      );

      // leaf workspace-level tables
      await pool.query(
        `DELETE FROM "${S}".opportunities WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".experiments WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".okr_cycles WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".feedback WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".squads WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".docs WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".custom_field_values
         WHERE field_id IN (
           SELECT id FROM "${S}".custom_field_definitions WHERE workspace_id = $1
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".custom_field_definitions WHERE workspace_id = $1`,
        [wsId]
      );
      // NOTE: api_keys are user-scoped (no workspace_id column) — seeder
      // doesn't create any, so nothing to clean here.
      await pool.query(
        `DELETE FROM "${S}".workspace_members WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".workspaces WHERE id = $1`,
        [wsId]
      );
    }

    await pool.query(
      `DELETE FROM "${S}".organization_members WHERE organization_id = $1`,
      [orgId]
    );
    await pool.query(
      `DELETE FROM "${S}".organizations WHERE id = $1`,
      [orgId]
    );

    console.log("[e2e teardown] Cleaned up e2e test data ✓");
  } finally {
    await pool.end();
  }
}
