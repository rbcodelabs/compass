#!/usr/bin/env node
/**
 * Seeds a dedicated, throwaway org/workspace with a large synthetic set of
 * OKR cycles/Objectives/Key Results, for manually verifying the Canvas
 * viewer's render/pan/zoom performance at "hundreds of Objectives across
 * many cycles" — Phase 1's stated acceptance criterion (design doc §8; see
 * also the Canvas Phase 1 plan's Step 7). No automated perf-assertion
 * tooling exists in this repo (no Lighthouse CI, no Playwright perf
 * traces) — this script only prepares the data; the actual check is manual
 * (load the printed URL, watch DevTools FPS while panning/zooming).
 *
 * Independent of `e2e-test-org` (functional E2E fixtures) and the
 * `rbcodelabs/compass` docs-screenshot demo workspace — safe to run
 * repeatedly without colliding with either.
 *
 * Usage:
 *   node --env-file=.env.local --experimental-strip-types scripts/seed-canvas-scale.ts
 *
 * CANVAS_SCALE_OBJECTIVES (default 400) sets the approximate total
 * Objective count; always creates at least 20 cycles regardless. Re-running
 * wipes and regenerates this workspace's OKR data each time, so the scale
 * of a given run is always exactly what you asked for — not creeping
 * upward across repeated runs the way an insert-only idempotent seed would.
 */
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Mirror what getActiveSchema() returns when NODE_ENV=development.
const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

const ORG_SLUG = "canvas-scale-test-org";
const WORKSPACE_SLUG = "canvas-scale";
const USER_EMAIL = "canvas-scale-seed@localhost.dev";
const TARGET_OBJECTIVES = Number(process.env.CANVAS_SCALE_OBJECTIVES ?? 400);
const MIN_CYCLES = 20;
const OBJECTIVE_STATUSES = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"];

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

async function one<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T> {
  const rows = await q<T>(sql, params);
  if (!rows[0]) throw new Error(`Expected a row from: ${sql}`);
  return rows[0];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — run with --env-file=.env.local (local dev only; this script never targets Aurora DSQL)."
    );
  }

  console.log(
    `Seeding canvas scale test data (target ~${TARGET_OBJECTIVES} objectives across >=${MIN_CYCLES} cycles)...`
  );

  const user = await one<{ id: string }>(
    `
    INSERT INTO "${S}".users (id, name, email, email_verified, created_at)
    VALUES (gen_random_uuid(), 'Canvas Scale Seed', $1, NOW(), NOW())
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `,
    [USER_EMAIL]
  );

  const org = await one<{ id: string }>(
    `
    INSERT INTO "${S}".organizations (id, slug, name, created_at)
    VALUES (gen_random_uuid(), $1, 'Canvas Scale Test Org', NOW())
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `,
    [ORG_SLUG]
  );

  await pool.query(
    `
    INSERT INTO "${S}".organization_members (id, organization_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (organization_id, user_id) DO NOTHING
  `,
    [org.id, user.id]
  );

  const ws = await one<{ id: string }>(
    `
    INSERT INTO "${S}".workspaces
      (id, organization_id, slug, name, roadmap_public, feedback_enabled, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, 'Canvas Scale', false, false, NOW(), NOW())
    ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `,
    [org.id, WORKSPACE_SLUG]
  );

  await pool.query(
    `
    INSERT INTO "${S}".workspace_members (id, workspace_id, user_id, role, created_at)
    VALUES (gen_random_uuid(), $1, $2, 'ADMIN', NOW())
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  `,
    [ws.id, user.id]
  );

  // Wipe this workspace's prior OKR data so each run produces exactly the
  // requested scale, in strict dependency order (no DB-level cascades).
  await pool.query(
    `
    DELETE FROM "${S}".key_results WHERE objective_id IN (
      SELECT id FROM "${S}".objectives WHERE cycle_id IN (
        SELECT id FROM "${S}".okr_cycles WHERE workspace_id = $1
      )
    )
  `,
    [ws.id]
  );
  await pool.query(
    `
    DELETE FROM "${S}".objectives WHERE cycle_id IN (
      SELECT id FROM "${S}".okr_cycles WHERE workspace_id = $1
    )
  `,
    [ws.id]
  );
  await pool.query(`DELETE FROM "${S}".okr_cycles WHERE workspace_id = $1`, [
    ws.id,
  ]);

  let objectivesCreated = 0;
  let cycleIndex = 0;
  const startYear = 2024;

  while (objectivesCreated < TARGET_OBJECTIVES || cycleIndex < MIN_CYCLES) {
    cycleIndex++;
    const quarter = ((cycleIndex - 1) % 4) + 1;
    const year = startYear + Math.floor((cycleIndex - 1) / 4);
    const cycleTitle = `Q${quarter} ${year} Synthetic Cycle ${cycleIndex}`;

    const cycle = await one<{ id: string }>(
      `
      INSERT INTO "${S}".okr_cycles
        (id, workspace_id, title, status, start_date, end_date, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, 'CLOSED', $3, $4, NOW(), NOW())
      RETURNING id
    `,
      [ws.id, cycleTitle, `${year}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`, `${year}-${String(quarter * 3).padStart(2, "0")}-28`]
    );

    const objectivesInCycle = randInt(2, 15);
    for (let i = 0; i < objectivesInCycle; i++) {
      const objTitle = `Synthetic Objective ${cycleIndex}.${i + 1}`;
      const obj = await one<{ id: string }>(
        `
        INSERT INTO "${S}".objectives
          (id, cycle_id, title, status, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
        RETURNING id
      `,
        [cycle.id, objTitle, pick(OBJECTIVE_STATUSES), i]
      );

      const keyResultCount = randInt(1, 4);
      for (let k = 0; k < keyResultCount; k++) {
        const target = randInt(10, 1000);
        await pool.query(
          `
          INSERT INTO "${S}".key_results
            (id, objective_id, title, target, current, sort_order, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
        `,
          [
            obj.id,
            `Synthetic KR ${cycleIndex}.${i + 1}.${k + 1}`,
            target,
            randInt(0, target),
            k,
          ]
        );
      }

      objectivesCreated++;
      if (objectivesCreated >= TARGET_OBJECTIVES && cycleIndex >= MIN_CYCLES) {
        break;
      }
    }
  }

  console.log(
    `Seeded ${cycleIndex} cycles, ${objectivesCreated} objectives (org=${org.id} workspace=${ws.id}).`
  );
  console.log(
    `\nOpen: http://localhost:3008/${ORG_SLUG}/${WORKSPACE_SLUG}/canvas`
  );
  console.log("(adjust the port if your local dev server isn't on 3008)");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
