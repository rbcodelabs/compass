/**
 * INTENTIONAL NULL workspaceId: the raw INSERTs below deliberately omit workspace_id. They simulate rows written by
 * pre-068 code (and late rows inserted by old instances) so the backfill has something to fill. The write-path guard
 * (__tests__/tenant-isolation/solution-objective-write-paths.test.ts) allow-lists this file by name and requires this marker.
 *
 * Runs the REGISTERED migration 068 through the real runner (`applyMigrations`)
 * against a throwaway schema in the local compass_e2e database. Never touches
 * Aurora or any shared environment.
 *
 *   WORKSPACE_ID_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/workspace-id-on-solution-objective-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "@/lib/migrations/runner";
import { WORKSPACE_ID_BACKFILL_BATCH_SIZE, getWorkspaceIdBackfillStatus, repairWorkspaceIdResidual } from "@/lib/migrations/workspace-id-on-solution-objective";

const MIGRATION = "068_workspace_id_on_solution_objective";
const databaseUrl = process.env.WORKSPACE_ID_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("068 workspace_id on solutions and objectives (registered migration)", () => {
  const schema = `wsid_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const previous = process.env.DATABASE_URL;
  const WS_A = randomUUID();
  const WS_B = randomUUID();
  const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql.replaceAll("{S}", `"${schema}"`), params);

  async function apply() {
    const response = await applyMigrations(pool, schema, MIGRATION);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const receipts = async () =>
    Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [MIGRATION])).rows[0].n);

  let cycleA: string;
  let cycleB: string;
  let oppA: string;
  let oppB: string;
  // Enough rows that the backfill must loop several batches.
  const SOLUTIONS_PER_WORKSPACE = WORKSPACE_ID_BACKFILL_BATCH_SIZE + 200;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
      throw new Error("Requires the local compass_e2e database");
    }
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const init = await applyMigrations(pool, schema, "001_init");
    expect(init.status, JSON.stringify(await init.json())).toBe(200);

    // Pre-068 state: rows exist with no workspace_id column at all.
    [cycleA, cycleB] = [randomUUID(), randomUUID()];
    [oppA, oppB] = [randomUUID(), randomUUID()];
    await q(`INSERT INTO {S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1,$2,'A','2026-01-01','2026-03-31'), ($3,$4,'B','2026-01-01','2026-03-31')`, [cycleA, WS_A, cycleB, WS_B]);
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title) VALUES ($1,$2,'opp A'), ($3,$4,'opp B')`, [oppA, WS_A, oppB, WS_B]);
    await q(`INSERT INTO {S}.objectives (id, cycle_id, title) SELECT gen_random_uuid(), $1, 'obj A ' || g FROM generate_series(1, 3) g`, [cycleA]);
    await q(`INSERT INTO {S}.objectives (id, cycle_id, title) SELECT gen_random_uuid(), $1, 'obj B ' || g FROM generate_series(1, 2) g`, [cycleB]);
    await q(`INSERT INTO {S}.solutions (id, opportunity_id, title) SELECT gen_random_uuid(), $1, 'sol A ' || g FROM generate_series(1, $2::int) g`, [oppA, SOLUTIONS_PER_WORKSPACE]);
    await q(`INSERT INTO {S}.solutions (id, opportunity_id, title) SELECT gen_random_uuid(), $1, 'sol B ' || g FROM generate_series(1, $2::int) g`, [oppB, SOLUTIONS_PER_WORKSPACE]);
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  async function preflight() {
    const client = await pool.connect();
    try {
      return await getWorkspaceIdBackfillStatus(client, schema);
    } finally {
      client.release();
    }
  }

  it("preflight (GET status) shows the columns absent and zero orphans before the migration runs", async () => {
    expect(await preflight()).toEqual({ columnsPresent: false, orphans: { solutions: 0, objectives: 0 }, nullWorkspaceId: null, parentDrift: null });
  });

  it("backfills every row from its parent across multiple batches and records one receipt", async () => {
    const { status, body } = await apply();
    expect(body, JSON.stringify(body)).not.toHaveProperty("error");
    expect(status).toBe(200);
    expect(String(body.message)).toContain(`backfilled ${SOLUTIONS_PER_WORKSPACE * 2} solutions.workspace_id rows`);
    expect(String(body.message)).toContain("backfilled 5 objectives.workspace_id rows");

    const nulls = await q(`SELECT (SELECT count(*) FROM {S}.solutions WHERE workspace_id IS NULL)::int AS s, (SELECT count(*) FROM {S}.objectives WHERE workspace_id IS NULL)::int AS o`);
    expect(nulls.rows[0]).toEqual({ s: 0, o: 0 });
    const disagreeing = await q(`SELECT
      (SELECT count(*) FROM {S}.solutions s JOIN {S}.opportunities p ON p.id = s.opportunity_id WHERE s.workspace_id <> p.workspace_id)::int AS s,
      (SELECT count(*) FROM {S}.objectives o JOIN {S}.okr_cycles c ON c.id = o.cycle_id WHERE o.workspace_id <> c.workspace_id)::int AS o`);
    expect(disagreeing.rows[0]).toEqual({ s: 0, o: 0 });
    const perWorkspace = await q<{ workspace_id: string; n: number }>(`SELECT workspace_id, count(*)::int AS n FROM {S}.solutions GROUP BY workspace_id`);
    expect(Object.fromEntries(perWorkspace.rows.map((r) => [r.workspace_id, r.n]))).toEqual({ [WS_A]: SOLUTIONS_PER_WORKSPACE, [WS_B]: SOLUTIONS_PER_WORKSPACE });

    const indexes = await q(`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) ORDER BY 1`, [schema, ["idx_objectives_workspace_id", "idx_solutions_workspace_id"]]);
    expect(indexes.rows).toEqual([
      { relname: "idx_objectives_workspace_id", indisvalid: true },
      { relname: "idx_solutions_workspace_id", indisvalid: true },
    ]);
    expect(await receipts()).toBe(1);
    expect(await preflight()).toEqual({ columnsPresent: true, orphans: { solutions: 0, objectives: 0 }, nullWorkspaceId: { solutions: 0, objectives: 0 }, parentDrift: { solutions: 0, objectives: 0 } });
  });

  it("is idempotent: a second run applies nothing and leaves the data and the single receipt alone", async () => {
    const before = await q(`SELECT id, workspace_id FROM {S}.solutions ORDER BY id`);
    const again = await apply();
    expect(again.status).toBe(200);
    expect(String(again.body.message)).toContain("Nothing to apply");
    expect((await q(`SELECT id, workspace_id FROM {S}.solutions ORDER BY id`)).rows).toEqual(before.rows);
    expect(await receipts()).toBe(1);
  });

  it("resumes: after a crash that left NULL rows and no receipt, a rerun finishes the backfill", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    await q(`UPDATE {S}.solutions SET workspace_id = NULL WHERE id IN (SELECT id FROM {S}.solutions LIMIT 600)`);
    await q(`UPDATE {S}.objectives SET workspace_id = NULL`);
    const rerun = await apply();
    expect(rerun.body, JSON.stringify(rerun.body)).not.toHaveProperty("error");
    expect(rerun.status).toBe(200);
    expect(String(rerun.body.message)).toContain("backfilled 600 solutions.workspace_id rows");
    expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.solutions WHERE workspace_id IS NULL`)).rows[0].n)).toBe(0);
    expect(await receipts()).toBe(1);
  });

  it("fails closed, with no receipt, when a solution has no parent opportunity to derive from", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    const orphan = randomUUID();
    await q(`INSERT INTO {S}.solutions (id, opportunity_id, title) VALUES ($1, $2, 'orphan')`, [orphan, randomUUID()]);
    expect((await preflight()).orphans.solutions).toBe(1);
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/^068_workspace_id_on_solution_objective: backfill postcondition failed: 1 solutions rows still have NULL workspace_id \(1 reference a missing opportunities row, 0 have no opportunity_id at all/);
    expect(await receipts()).toBe(0);

    // Operator repairs the data; the same migration then completes.
    await q(`DELETE FROM {S}.solutions WHERE id = $1`, [orphan]);
    const recovered = await apply();
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(await receipts()).toBe(1);
  });

  it("fails closed, with no receipt, when a row's workspace_id disagrees with its parent's", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    // Backfill only fills NULL, so a wrong non-NULL value must be caught by the agreement postcondition.
    // (Status is read after the UPDATE below.)
    await q(`UPDATE {S}.objectives SET workspace_id = $1 WHERE cycle_id = $2 AND id = (SELECT id FROM {S}.objectives WHERE cycle_id = $2 LIMIT 1)`, [WS_B, cycleA]);
    expect((await preflight()).parentDrift).toEqual({ solutions: 0, objectives: 1 });
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/agreement postcondition failed: 1 objectives rows disagree with their okr_cycles parent/);
    expect(await receipts()).toBe(0);

    await q(`UPDATE {S}.objectives SET workspace_id = $1 WHERE cycle_id = $2`, [WS_A, cycleA]);
    const recovered = await apply();
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(await receipts()).toBe(1);
  });

  describe("069 residual backfill (rows inserted by old code after 068's receipt)", () => {
    const RESIDUAL = "069_workspace_id_residual_backfill";
    const applyResidual = async () => {
      const response = await applyMigrations(pool, schema, RESIDUAL);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const residualReceipts = async () =>
      Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [RESIDUAL])).rows[0].n);

    it("068 is already receipted, so a late NULL row is invisible to it, but 069 backfills it and records its own receipt", async () => {
      // Old code (no workspace_id in its INSERT) keeps inserting after 068's receipt was written.
      await q(`INSERT INTO {S}.solutions (id, opportunity_id, title) SELECT gen_random_uuid(), $1, 'late ' || g FROM generate_series(1, 3) g`, [oppA]);
      await q(`INSERT INTO {S}.objectives (id, cycle_id, title) VALUES (gen_random_uuid(), $1, 'late objective')`, [cycleB]);
      expect((await preflight()).nullWorkspaceId).toEqual({ solutions: 3, objectives: 1 });
      const again068 = await apply();
      expect(String(again068.body.message)).toContain("Nothing to apply");
      expect((await preflight()).nullWorkspaceId).toEqual({ solutions: 3, objectives: 1 });

      const result = await applyResidual();
      expect(result.body, JSON.stringify(result.body)).not.toHaveProperty("error");
      expect(result.status).toBe(200);
      expect(String(result.body.message)).toContain("backfilled 3 solutions.workspace_id rows");
      expect(String(result.body.message)).toContain("backfilled 1 objectives.workspace_id rows");
      expect((await preflight()).nullWorkspaceId).toEqual({ solutions: 0, objectives: 0 });
      expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.solutions WHERE opportunity_id = $1 AND workspace_id = $2`, [oppA, WS_A])).rows[0].n)).toBe(SOLUTIONS_PER_WORKSPACE + 3);
      expect(await residualReceipts()).toBe(1);
      expect((await applyResidual()).body.message).toContain("Nothing to apply");
    });

    it("fails closed with no receipt when an orphan appeared", async () => {
      await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [RESIDUAL]);
      await q(`INSERT INTO {S}.objectives (id, cycle_id, title) VALUES (gen_random_uuid(), $1, 'orphan objective')`, [randomUUID()]);
      const failed = await applyResidual();
      expect(failed.status).toBe(500);
      // The error names 069 (not 068) and says what kind of orphan it is.
      expect(String(failed.body.error)).toMatch(/^069_workspace_id_residual_backfill: backfill postcondition failed: 1 objectives rows still have NULL workspace_id \(1 reference a missing okr_cycles row, 0 have no cycle_id at all/);
      expect(await residualReceipts()).toBe(0);
    });

    it("an Objective with NEITHER a workspace_id NOR a cycle (Phase 1 cycle-less) cannot derive a workspace: fails closed, reported separately, and is skipped by the join", async () => {
      await q(`DELETE FROM {S}.objectives WHERE title = 'orphan objective'`);
      // Phase 1 (#332) makes objectives.cycle_id nullable; simulate it in the throwaway schema.
      await q(`ALTER TABLE {S}.objectives ALTER COLUMN cycle_id DROP NOT NULL`);
      // A cycle-less Objective that DOES carry its workspace_id (what Phase 1 create_objective writes) is fine...
      await q(`INSERT INTO {S}.objectives (id, workspace_id, cycle_id, title) VALUES (gen_random_uuid(), $1, NULL, 'cycle-less with workspace')`, [WS_A]);
      await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [RESIDUAL]);
      const ok = await applyResidual();
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await residualReceipts()).toBe(1);
      // ...and neither the backfill nor the agreement check touches it.
      expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.objectives WHERE title = 'cycle-less with workspace' AND workspace_id = $1`, [WS_A])).rows[0].n)).toBe(1);

      // One with no workspace_id AND no cycle has nothing to derive from.
      await q(`INSERT INTO {S}.objectives (id, cycle_id, title) VALUES (gen_random_uuid(), NULL, 'cycle-less, no workspace')`);
      await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [RESIDUAL]);
      const failed = await applyResidual();
      expect(failed.status).toBe(500);
      expect(String(failed.body.error)).toMatch(/^069_workspace_id_residual_backfill: .*1 objectives rows still have NULL workspace_id \(0 reference a missing okr_cycles row, 1 have no cycle_id at all and nothing to derive a workspace from/);
      expect(await residualReceipts()).toBe(0);
      await q(`DELETE FROM {S}.objectives WHERE title = 'cycle-less, no workspace'`);
      const recovered = await applyResidual();
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    });

    it("the repeatable repair fills late NULL rows AFTER the one-shot receipt, every time it is run, with no receipt and no DDL", async () => {
      const receiptsBefore = await residualReceipts();
      for (const round of [1, 2]) {
        await q(`INSERT INTO {S}.solutions (id, opportunity_id, title) VALUES (gen_random_uuid(), $1, $2)`, [oppB, `after the receipt ${round}`]);
        expect((await preflight()).nullWorkspaceId?.solutions).toBe(1);
        const client = pool;
        const result = await repairWorkspaceIdResidual(client, schema);
        expect(result.before.nullWorkspaceId).toEqual({ solutions: 1, objectives: 0 });
        expect(result.log).toContain("  ✓ backfilled 1 solutions.workspace_id rows");
        expect(result.after.nullWorkspaceId).toEqual({ solutions: 0, objectives: 0 });
      }
      expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.solutions WHERE title LIKE 'after the receipt %' AND workspace_id = $1`, [WS_B])).rows[0].n)).toBe(2);
      expect(await residualReceipts()).toBe(receiptsBefore); // no new receipt
      // Idempotent when there is nothing to do.
      expect((await repairWorkspaceIdResidual(pool, schema)).log).toContain("  ✓ backfilled 0 solutions.workspace_id rows");
    });

    it("the repeatable repair fails closed, reporting before-counts, on an orphan", async () => {
      const orphan = randomUUID();
      await q(`INSERT INTO {S}.solutions (id, opportunity_id, title) VALUES ($1, $2, 'orphan for repair')`, [orphan, randomUUID()]);
      await expect(repairWorkspaceIdResidual(pool, schema)).rejects.toMatchObject({
        message: expect.stringMatching(/^backfill-workspace-id: backfill postcondition failed: 1 solutions rows still have NULL workspace_id/),
        before: { columnsPresent: true, orphans: { solutions: 1 } },
      });
      await q(`DELETE FROM {S}.solutions WHERE id = $1`, [orphan]);
    });
  });
});
