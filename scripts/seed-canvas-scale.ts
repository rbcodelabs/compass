#!/usr/bin/env node
/**
 * Seeds a dedicated, throwaway org/workspace with a large synthetic OST +
 * Roadmap graph — OKR cycles/Objectives/Key Results, plus Opportunities,
 * Solutions, Assumptions, Experiments, and RoadmapItems — for manually
 * verifying the Canvas viewer's render/pan/zoom performance and edge
 * correctness at scale (see the Canvas OST + Roadmap Graph plan's
 * Verification section). No automated perf-assertion tooling exists in this
 * repo (no Lighthouse CI, no Playwright perf traces) — this script only
 * prepares the data; the actual check is manual (load the printed URL,
 * watch DevTools FPS while panning/zooming, spot-check edges).
 *
 * Independent of `e2e-test-org` (functional E2E fixtures) and the
 * `rbcodelabs/compass` docs-screenshot demo workspace — safe to run
 * repeatedly without colliding with either.
 *
 * Usage:
 *   node --env-file=.env.local --experimental-strip-types scripts/seed-canvas-scale.ts
 *
 * CANVAS_SCALE_OBJECTIVES (default 80) sets the approximate total Objective
 * count; always creates at least 20 cycles regardless. Deliberately smaller
 * than the Objective-only Phase's 400 — KeyResult promotion to a real node
 * type plus 5 new entity types already multiplies node count well beyond
 * that; a full combinatorial OST seed at 400 Objectives would stress ELK far
 * beyond a meaningful check. Full un-tiered scale is exactly the problem
 * semantic zoom tiers solve later, not this increment.
 *
 * Re-running wipes and regenerates this workspace's OKR + OST + Roadmap data
 * each time, so the scale of a given run is always exactly what you asked
 * for — not creeping upward across repeated runs the way an insert-only
 * idempotent seed would.
 */
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Mirror what getActiveSchema() returns when NODE_ENV=development.
const S = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

const ORG_SLUG = process.env.CANVAS_SCALE_ORG_SLUG ?? "canvas-scale-test-org";
const WORKSPACE_SLUG = process.env.CANVAS_SCALE_WORKSPACE_SLUG ?? "canvas-scale";
const USER_EMAIL = process.env.CANVAS_SCALE_USER_EMAIL ?? "canvas-scale-seed@localhost.dev";
const TARGET_OBJECTIVES = Number(process.env.CANVAS_SCALE_OBJECTIVES ?? 80);
const MIN_CYCLES = Number(process.env.CANVAS_SCALE_MIN_CYCLES ?? 20);
const OBJECTIVE_STATUSES = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "COMPLETE"];
const OPPORTUNITY_STATUSES = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"];
const SOLUTION_STATUSES = ["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"];
const RISK_LEVELS = ["HIGH", "MEDIUM", "LOW"];
const ASSUMPTION_STATUSES = ["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"];
const EXPERIMENT_STATUSES = ["DESIGNING", "RUNNING", "COMPLETE", "KILLED"];
const CONCLUSIONS = ["PROCEED", "KILL", "ITERATE"];
const HORIZONS = ["NOW", "NEXT", "LATER", "SHIPPED"];
const FEEDBACK_TYPES = ["BUG", "IDEA"];

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
    `Seeding canvas scale test data (target ~${TARGET_OBJECTIVES} objectives across >=${MIN_CYCLES} cycles, plus OST + Roadmap)...`
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

  // Wipe this workspace's prior OST + Roadmap + OKR data so each run
  // produces exactly the requested scale, in strict FK-dependency order (no
  // DB-level cascades). Roadmap/Experiment/Assumption before
  // Solution/Opportunity, before Objective/KeyResult.
  await pool.query(
    `DELETE FROM "${S}".roadmap_items WHERE workspace_id = $1`,
    [ws.id]
  );
  await pool.query(`DELETE FROM "${S}".feedback WHERE workspace_id = $1`, [
    ws.id,
  ]);
  await pool.query(
    `DELETE FROM "${S}".experiments WHERE workspace_id = $1`,
    [ws.id]
  );
  await pool.query(
    `
    DELETE FROM "${S}".assumptions WHERE solution_id IN (
      SELECT id FROM "${S}".solutions WHERE opportunity_id IN (
        SELECT id FROM "${S}".opportunities WHERE workspace_id = $1
      )
    )
  `,
    [ws.id]
  );
  await pool.query(
    `
    DELETE FROM "${S}".solutions WHERE opportunity_id IN (
      SELECT id FROM "${S}".opportunities WHERE workspace_id = $1
    )
  `,
    [ws.id]
  );
  await pool.query(
    `DELETE FROM "${S}".opportunities WHERE workspace_id = $1`,
    [ws.id]
  );
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

  // ── OKR cycles / Objectives / Key Results ─────────────────────────────
  let objectivesCreated = 0;
  let cycleIndex = 0;
  const startYear = 2024;
  const allKeyResultIds: string[] = [];

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
        const kr = await one<{ id: string }>(
          `
          INSERT INTO "${S}".key_results
            (id, objective_id, title, target, current, sort_order, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
          RETURNING id
        `,
          [
            obj.id,
            `Synthetic KR ${cycleIndex}.${i + 1}.${k + 1}`,
            target,
            randInt(0, target),
            k,
          ]
        );
        allKeyResultIds.push(kr.id);
      }

      objectivesCreated++;
      if (objectivesCreated >= TARGET_OBJECTIVES && cycleIndex >= MIN_CYCLES) {
        break;
      }
    }
  }

  // ── Opportunities (~60), ~half linked to a seeded Key Result ──────────
  const OPPORTUNITY_COUNT = 60;
  const opportunityIds: string[] = [];
  for (let i = 0; i < OPPORTUNITY_COUNT; i++) {
    const linkedKeyResultId =
      allKeyResultIds.length > 0 && i % 2 === 0 ? pick(allKeyResultIds) : null;
    const opp = await one<{ id: string }>(
      `
      INSERT INTO "${S}".opportunities
        (id, workspace_id, title, status, linked_key_result_id, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING id
    `,
      [ws.id, `Synthetic Opportunity ${i + 1}`, pick(OPPORTUNITY_STATUSES), linkedKeyResultId, i]
    );
    opportunityIds.push(opp.id);
  }

  // ── Solutions (~90, 1-2 per Opportunity) ───────────────────────────────
  const solutionIds: string[] = [];
  let solutionCounter = 0;
  for (const oppId of opportunityIds) {
    const count = randInt(1, 2);
    for (let i = 0; i < count; i++) {
      solutionCounter++;
      const sol = await one<{ id: string }>(
        `
        INSERT INTO "${S}".solutions
          (id, opportunity_id, title, status, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
        RETURNING id
      `,
        [oppId, `Synthetic Solution ${solutionCounter}`, pick(SOLUTION_STATUSES), i]
      );
      solutionIds.push(sol.id);
      if (solutionIds.length >= 90) break;
    }
    if (solutionIds.length >= 90) break;
  }

  // ── Assumptions (~120, 1-2 per Solution) ───────────────────────────────
  const assumptionIds: string[] = [];
  let assumptionCounter = 0;
  for (const solId of solutionIds) {
    const count = randInt(1, 2);
    for (let i = 0; i < count; i++) {
      assumptionCounter++;
      const a = await one<{ id: string }>(
        `
        INSERT INTO "${S}".assumptions
          (id, solution_id, title, risk_level, status, sort_order, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING id
      `,
        [solId, `Synthetic Assumption ${assumptionCounter}`, pick(RISK_LEVELS), pick(ASSUMPTION_STATUSES), i]
      );
      assumptionIds.push(a.id);
      if (assumptionIds.length >= 120) break;
    }
    if (assumptionIds.length >= 120) break;
  }

  // ── Experiments (~100): ~70% linked to an Assumption, ~30% independent ─
  const EXPERIMENT_COUNT = 100;
  const experimentIds: string[] = [];
  for (let i = 0; i < EXPERIMENT_COUNT; i++) {
    const linked = assumptionIds.length > 0 && Math.random() < 0.7;
    const assumptionId = linked ? pick(assumptionIds) : null;
    const status = pick(EXPERIMENT_STATUSES);
    const conclusion = status === "COMPLETE" ? pick(CONCLUSIONS) : null;
    const exp = await one<{ id: string }>(
      `
      INSERT INTO "${S}".experiments
        (id, workspace_id, assumption_id, title, hypothesis, method, kill_condition, status, conclusion, sort_order, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'Synthetic hypothesis', 'Synthetic method', 'Synthetic kill condition', $4, $5, $6, NOW(), NOW())
      RETURNING id
    `,
      [ws.id, assumptionId, `Synthetic Experiment ${i + 1}`, status, conclusion, i]
    );
    experimentIds.push(exp.id);
  }

  // ── Feedback (for RoadmapItem.feedbackId -> isBug) ─────────────────────
  const FEEDBACK_COUNT = 20;
  const feedbackIds: string[] = [];
  for (let i = 0; i < FEEDBACK_COUNT; i++) {
    const fb = await one<{ id: string }>(
      `
      INSERT INTO "${S}".feedback
        (id, workspace_id, title, type, status, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'OPEN', NOW(), NOW())
      RETURNING id
    `,
      [ws.id, `Synthetic Feedback ${i + 1}`, pick(FEEDBACK_TYPES)]
    );
    feedbackIds.push(fb.id);
  }

  // ── RoadmapItems (~100): primary-only / multi-parent / orphan mixes ───
  const ROADMAP_COUNT = 100;
  let roadmapCreated = 0;
  for (let i = 0; i < ROADMAP_COUNT; i++) {
    let solutionId: string | null = null;
    let experimentId: string | null = null;
    let opportunityId: string | null = null;
    let keyResultId: string | null = null;
    let feedbackId: string | null = null;

    const bucket = i % 10;
    if (bucket < 4) {
      // Primary-only: exactly one FK set, exercises simple solid-edge cases.
      const choice = randInt(0, 3);
      if (choice === 0 && solutionIds.length > 0) solutionId = pick(solutionIds);
      else if (choice === 1 && experimentIds.length > 0) experimentId = pick(experimentIds);
      else if (choice === 2 && opportunityIds.length > 0) opportunityId = pick(opportunityIds);
      else if (allKeyResultIds.length > 0) keyResultId = pick(allKeyResultIds);
    } else if (bucket < 7) {
      // Multi-parent: 2-3 FKs set, exercises precedence + dashed edges.
      if (solutionIds.length > 0) solutionId = pick(solutionIds);
      if (experimentIds.length > 0) experimentId = pick(experimentIds);
      if (Math.random() < 0.5 && opportunityIds.length > 0) opportunityId = pick(opportunityIds);
      if (Math.random() < 0.5 && allKeyResultIds.length > 0) keyResultId = pick(allKeyResultIds);
    } else if (bucket < 9) {
      // Orphan, feedback-only: no resolvable edge parent, still shows isBug.
      if (feedbackIds.length > 0) feedbackId = pick(feedbackIds);
    }
    // bucket === 9: true orphan, nothing set at all.

    await pool.query(
      `
      INSERT INTO "${S}".roadmap_items
        (id, workspace_id, title, horizon, status, sort_order, solution_id, key_result_id, opportunity_id, experiment_id, feedback_id, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'ACTIVE', $4, $5, $6, $7, $8, $9, NOW(), NOW())
    `,
      [ws.id, `Synthetic Roadmap Item ${i + 1}`, pick(HORIZONS), i, solutionId, keyResultId, opportunityId, experimentId, feedbackId]
    );
    roadmapCreated++;
  }

  const totalNodes =
    objectivesCreated +
    allKeyResultIds.length +
    opportunityIds.length +
    solutionIds.length +
    assumptionIds.length +
    experimentIds.length +
    roadmapCreated;

  console.log(
    `Seeded ${cycleIndex} cycles, ${objectivesCreated} objectives, ${allKeyResultIds.length} key results, ` +
      `${opportunityIds.length} opportunities, ${solutionIds.length} solutions, ${assumptionIds.length} assumptions, ` +
      `${experimentIds.length} experiments, ${roadmapCreated} roadmap items (org=${org.id} workspace=${ws.id}).`
  );
  console.log(`Total canvas node count: ${totalNodes}`);
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
