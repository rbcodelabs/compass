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
import { rm } from "node:fs/promises";
import pg from "pg";
import {
  E2E_ORG_SLUG,
  COMPASS_META_ORG_SLUG,
  COMPASS_META_WORKSPACE_SLUG,
} from "./fixtures/seed-e2e";
import { readRunToken, clearRunToken, orgNameForToken } from "./fixtures/run-token";
import { assertIsolatedE2EDatabase } from "./fixtures/isolated-database";

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

  const runToken = readRunToken();
  if (!runToken) {
    console.warn(
      "[e2e teardown] Refusing to clean up: global setup did not establish run ownership."
    );
    return;
  }

  // Setup safety is incomplete if teardown can later target a different DB.
  await assertIsolatedE2EDatabase();

  const pool = new pg.Pool({ connectionString });
  try {
    // ── Ownership check ───────────────────────────────────────────────────
    // Everything below deletes by slug (the e2e org) or by an `E2E %` title
    // prefix (the meta workspace's feedback rows). Neither is specific to this
    // run, so a teardown belonging to an interrupted run would happily destroy
    // a *live* run's data — which is exactly what happened three times during
    // #120/#121. Bail out unless the org still carries this run's stamp.
    const { rows: ownerRows } = await pool.query<{ name: string }>(
      `SELECT name FROM "${S}".organizations WHERE slug = $1`,
      [E2E_ORG_SLUG]
    );
    const actual = ownerRows[0]?.name;
    const expected = orgNameForToken(runToken);
    if (actual && actual !== expected) {
      console.warn(
        `[e2e teardown] Refusing to clean up: the e2e org is stamped ` +
          `"${actual}" but this run holds "${expected}". Another run has ` +
          `claimed it since — deleting now would destroy live data.`
      );
      return;
    }

    // The "Send Feedback about Compass" target workspace (rbcodelabs/compass)
    // persists across runs like its production counterpart — only the test
    // feedback rows the global-feedback spec creates are cleaned up here
    // (titled "E2E ..." per this suite's naming convention), not the
    // workspace itself or any other seeded content in it.
    const { rows: metaWsRows } = await pool.query<{ id: string }>(
      `SELECT w.id FROM "${S}".workspaces w
       JOIN "${S}".organizations o ON o.id = w.organization_id
       WHERE o.slug = $1 AND w.slug = $2`,
      [COMPASS_META_ORG_SLUG, COMPASS_META_WORKSPACE_SLUG]
    );
    if (metaWsRows[0]) {
      await pool.query(
        `DELETE FROM "${S}".feedback WHERE workspace_id = $1 AND title LIKE 'E2E %'`,
        [metaWsRows[0].id]
      );
    }

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM "${S}".organizations WHERE slug = $1`,
      [E2E_ORG_SLUG]
    );
    if (!rows[0]) {
      console.log("[e2e teardown] e2e org not found — nothing to clean");
      clearRunToken();
      return;
    }
    const orgId = rows[0].id;

    const { rows: wsRows } = await pool.query<{ id: string }>(
      `SELECT id FROM "${S}".workspaces WHERE organization_id = $1`,
      [orgId]
    );

    for (const { id: wsId } of wsRows) {
      // ── Delete in strict dependency order (no DB-level cascades) ──────────
      for (const table of ["metric_observations", "metric_bindings", "metric_revisions", "metric_definitions", "analytics_connections", "workspace_activation_states"]) {
        await pool.query(`DELETE FROM "${S}"."${table}" WHERE workspace_id = $1`, [wsId]);
      }
      await pool.query(`DELETE FROM "${S}".research_participant_voice_events WHERE workspace_id = $1`, [wsId]);

      // research_blob_cleanups / research_attachments / research_voice_events / research_requests → research_turns → research_sessions /
      // research_participant_tokens / research_syntheses → research_studies
      await pool.query(
        `DELETE FROM "${S}".research_blob_cleanups WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_attachments WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_voice_events
         WHERE session_id IN (
           SELECT id FROM "${S}".research_sessions
           WHERE study_id IN (
             SELECT id FROM "${S}".research_studies WHERE workspace_id = $1
           )
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_requests
         WHERE session_id IN (
           SELECT id FROM "${S}".research_sessions
           WHERE study_id IN (
             SELECT id FROM "${S}".research_studies WHERE workspace_id = $1
           )
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_turns
         WHERE session_id IN (
           SELECT id FROM "${S}".research_sessions
           WHERE study_id IN (
             SELECT id FROM "${S}".research_studies WHERE workspace_id = $1
           )
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".pm_interviews WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_sessions
         WHERE study_id IN (
           SELECT id FROM "${S}".research_studies WHERE workspace_id = $1
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_participant_tokens
         WHERE study_id IN (
           SELECT id FROM "${S}".research_studies WHERE workspace_id = $1
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_syntheses
         WHERE study_id IN (
           SELECT id FROM "${S}".research_studies WHERE workspace_id = $1
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".experiment_research_study_links WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".research_studies WHERE workspace_id = $1`,
        [wsId]
      );

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

      // Immutable decision ledger and capacity reservations must be removed
      // before their roadmap-item and workspace subjects.
      await pool.query(
        `DELETE FROM "${S}".portfolio_capacity_reservations
         WHERE plan_id IN (SELECT id FROM "${S}".portfolio_capacity_plans WHERE workspace_id = $1)`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".portfolio_capacity_plans WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".decision_applications
         WHERE decision_id IN (SELECT id FROM "${S}".decision_records WHERE workspace_id = $1)`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".decision_records WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `UPDATE "${S}".review_requests SET current_revision_id = NULL WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".review_options
         WHERE revision_id IN (
           SELECT rr.id FROM "${S}".review_revisions rr
           JOIN "${S}".review_requests rq ON rq.id = rr.request_id
           WHERE rq.workspace_id = $1
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".review_revisions
         WHERE request_id IN (SELECT id FROM "${S}".review_requests WHERE workspace_id = $1)`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".review_requests WHERE workspace_id = $1`,
        [wsId]
      );

      // shared comments have application-enforced references, so remove them
      // before their workspace and targets.
      await pool.query(
        `DELETE FROM "${S}".comments WHERE workspace_id = $1`,
        [wsId]
      );

      // roadmap_items
      await pool.query(
        `DELETE FROM "${S}".roadmap_items WHERE workspace_id = $1`,
        [wsId]
      );

      // task_links → tasks (self-referencing parent_task_id has no DB FK, so
      // no ordering constraint between tasks themselves — just delete links first)
      await pool.query(
        `DELETE FROM "${S}".task_links
         WHERE task_id IN (
           SELECT id FROM "${S}".tasks WHERE workspace_id = $1
         )`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".tasks WHERE workspace_id = $1`,
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
        `DELETE FROM "${S}".artifact_links WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `UPDATE "${S}".artifacts SET current_revision_id = NULL WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".artifact_revisions WHERE artifact_id IN (SELECT id FROM "${S}".artifacts WHERE workspace_id = $1)`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".artifacts WHERE workspace_id = $1`,
        [wsId]
      );
      await pool.query(
        `DELETE FROM "${S}".artifact_blob_cleanups WHERE blob_pathname LIKE $1`,
        [`artifacts/${wsId}/%`]
      );
      await rm(path.join("/tmp", "compass-artifacts", "artifacts", wsId), { recursive: true, force: true });

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
      await pool.query(
        `DELETE FROM "${S}".shared_field_option_sets WHERE workspace_id = $1`,
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

    clearRunToken();
    console.log("[e2e teardown] Cleaned up e2e test data ✓");
  } finally {
    await pool.end();
  }
}
