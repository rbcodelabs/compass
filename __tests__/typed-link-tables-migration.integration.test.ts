/**
 * Runs the REGISTERED migration 071 (and its prerequisite 068) through the real
 * runner (`applyMigrations`) against a throwaway schema in the local compass_e2e
 * database. Never touches Aurora or any shared environment; the schema is dropped
 * in afterAll.
 *
 *   TYPED_LINK_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/typed-link-tables-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner";
import { TYPED_LINK_BACKFILL_BATCH_SIZE, getTypedLinkStatus } from "@/lib/migrations/typed-link-tables";

const MIGRATION = "071_typed_link_tables";
const PREREQUISITE = "068_workspace_id_on_solution_objective";
const databaseUrl = process.env.TYPED_LINK_TEST_DATABASE_URL ?? process.env.WORKSPACE_ID_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("071 typed link tables (registered migration)", () => {
  const schema = `tlnk_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const previous = process.env.DATABASE_URL;
  const WS_A = randomUUID();
  const WS_B = randomUUID();
  const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql.replaceAll("{S}", `"${schema}"`), params);

  async function apply(script = MIGRATION) {
    const response = await applyMigrations(pool, schema, script);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const receipts = async (name = MIGRATION) =>
    Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [name])).rows[0].n);
  const attempts = async () => Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION])).rows[0].n);
  const linkCount = async () => Number((await q(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links`)).rows[0].n);
  const tablesExist = async () =>
    Number((await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('opportunity_objective_links','solution_key_result_links')`, [schema])).rows[0].n);
  async function status() {
    const client = await pool.connect();
    try {
      return await getTypedLinkStatus(client, schema);
    } finally {
      client.release();
    }
  }

  // Same-workspace rows exceed one batch so the backfill must loop.
  const SAME_WORKSPACE_A = TYPED_LINK_BACKFILL_BATCH_SIZE + 150;
  const SAME_WORKSPACE_B = 3;
  const GOOD = SAME_WORKSPACE_A + SAME_WORKSPACE_B;
  let objA: string;
  let objB: string;
  let crossOpp: string;
  let danglingKrOpp: string;
  let danglingObjOpp: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") {
      throw new Error("Requires the local compass_e2e database");
    }
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const init = await applyMigrations(pool, schema, "001_init");
    expect(init.status, JSON.stringify(await init.json())).toBe(200);

    const [cycleA, cycleB] = [randomUUID(), randomUUID()];
    [objA, objB] = [randomUUID(), randomUUID()];
    const [krA, krB, krNoObjective] = [randomUUID(), randomUUID(), randomUUID()];
    [crossOpp, danglingKrOpp, danglingObjOpp] = [randomUUID(), randomUUID(), randomUUID()];
    await q(`INSERT INTO {S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1,$2,'A','2026-01-01','2026-03-31'), ($3,$4,'B','2026-01-01','2026-03-31')`, [cycleA, WS_A, cycleB, WS_B]);
    await q(`INSERT INTO {S}.objectives (id, cycle_id, title) VALUES ($1,$2,'obj A'), ($3,$4,'obj B')`, [objA, cycleA, objB, cycleB]);
    await q(`INSERT INTO {S}.key_results (id, objective_id, title, target) VALUES ($1,$2,'kr A',1), ($3,$4,'kr B',1), ($5,$6,'kr without objective',1)`, [krA, objA, krB, objB, krNoObjective, randomUUID()]);
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title, linked_key_result_id) SELECT gen_random_uuid(), $1, 'good A ' || g, $2 FROM generate_series(1, $3::int) g`, [WS_A, krA, SAME_WORKSPACE_A]);
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title, linked_key_result_id) SELECT gen_random_uuid(), $1, 'good B ' || g, $2 FROM generate_series(1, $3::int) g`, [WS_B, krB, SAME_WORKSPACE_B]);
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title) VALUES ('${randomUUID()}', $1, 'never linked')`, [WS_A]);
    // Orphans: cross-workspace (WS_A opportunity -> KR under WS_B's objective), dangling KR, KR whose objective is gone.
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title, linked_key_result_id) VALUES ($1,$2,'cross',$3), ($4,$2,'dangling kr',$5), ($6,$2,'dangling objective',$7)`, [crossOpp, WS_A, krB, danglingKrOpp, randomUUID(), danglingObjOpp, krNoObjective]);
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

  it("precondition: fails closed with no receipt, no attempt row and no tables when 068 is not applied", async () => {
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/precondition failed: 068_workspace_id_on_solution_objective is not applied/);
    expect(await receipts()).toBe(0);
    expect(await attempts()).toBe(0);
    expect(await tablesExist()).toBe(0);
  });

  it("precondition: fails closed when 068 is applied but an objective still has a NULL workspace_id", async () => {
    const prerequisite = await apply(PREREQUISITE);
    expect(prerequisite.status, JSON.stringify(prerequisite.body)).toBe(200);
    await q(`UPDATE {S}.objectives SET workspace_id = NULL WHERE id = $1`, [objA]);
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/1 objectives rows have a NULL workspace_id/);
    expect(await receipts()).toBe(0);
    expect(await tablesExist()).toBe(0);
    await q(`UPDATE {S}.objectives SET workspace_id = $2 WHERE id = $1`, [objA, WS_A]);
  });

  it("status preflight shows the quarantine size and a null linkIntegrity before the tables exist", async () => {
    const before = await status();
    expect(before.linkIntegrity).toBeNull();
    expect(before.preflight).toEqual({ tablesPresent: false, legacyDangling: 2, legacyCrossWorkspace: 1 });
  });

  it("backfills same-workspace rows across batches as LEGACY/MIGRATION and quarantines orphans without linking them", async () => {
    const { status: code, body } = await apply();
    expect(body, JSON.stringify(body)).not.toHaveProperty("error");
    expect(code).toBe(200);
    expect(String(body.message)).toContain(`inserted ${GOOD} LEGACY opportunity_objective_links rows`);
    expect(String(body.message)).toContain("quarantined 1 cross-workspace");
    expect(String(body.message)).toContain(crossOpp);
    expect(String(body.message)).toContain("quarantined 2 dangling");
    expect(String(body.message)).toContain(danglingKrOpp);
    expect(String(body.message)).toContain(danglingObjOpp);

    expect(await linkCount()).toBe(GOOD);
    const shape = await q<{ origin: string; source: string; n: number }>(`SELECT origin, source, count(*)::int AS n FROM {S}.opportunity_objective_links GROUP BY 1, 2`);
    expect(shape.rows).toEqual([{ origin: "LEGACY", source: "MIGRATION", n: GOOD }]);
    const perWorkspace = await q<{ workspace_id: string; objective_id: string; n: number }>(`SELECT workspace_id, objective_id, count(*)::int AS n FROM {S}.opportunity_objective_links GROUP BY 1, 2`);
    expect(Object.fromEntries(perWorkspace.rows.map((r) => [r.workspace_id, [r.objective_id, r.n]]))).toEqual({ [WS_A]: [objA, SAME_WORKSPACE_A], [WS_B]: [objB, SAME_WORKSPACE_B] });

    // Orphans: never linked, pointer untouched.
    const linkedOrphans = await q(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links WHERE opportunity_id = ANY($1::uuid[])`, [[crossOpp, danglingKrOpp, danglingObjOpp]]);
    expect(linkedOrphans.rows[0].n).toBe(0);
    const pointers = await q(`SELECT count(*)::int AS n FROM {S}.opportunities WHERE id = ANY($1::uuid[]) AND linked_key_result_id IS NOT NULL`, [[crossOpp, danglingKrOpp, danglingObjOpp]]);
    expect(pointers.rows[0].n).toBe(3);
    const legacyPointers = await q(`SELECT count(*)::int AS n FROM {S}.opportunities WHERE linked_key_result_id IS NOT NULL`);
    expect(legacyPointers.rows[0].n).toBe(GOOD + 3);

    const indexes = await q(`SELECT c.relname, i.indisvalid, i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname LIKE 'idx\\_%\\_links\\_%' ORDER BY 1`, [schema]);
    expect(indexes.rows).toHaveLength(6);
    expect(indexes.rows.every((r) => r.indisvalid === true)).toBe(true);
    expect(indexes.rows.filter((r) => r.indisunique).map((r) => r.relname)).toEqual(["idx_opportunity_objective_links_pair", "idx_solution_key_result_links_pair"]);
    expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.solution_key_result_links`)).rows[0].n)).toBe(0);
    expect(await receipts()).toBe(1);

    const after = await status();
    expect(after.linkIntegrity).toEqual({ legacyWithoutLink: 0, workspaceMismatch: 0, danglingEndpoint: 0, duplicates: 0, legacyCrossWorkspace: 1, legacyDangling: 2 });
  });

  it("GET status carries the linkIntegrity block", async () => {
    const response = await getMigrationStatus(pool, schema);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.linkIntegrity).toEqual({ legacyWithoutLink: 0, workspaceMismatch: 0, danglingEndpoint: 0, duplicates: 0, legacyCrossWorkspace: 1, legacyDangling: 2 });
  });

  it("is idempotent: a second run applies nothing and leaves the links and the single receipt alone", async () => {
    const before = await q(`SELECT id FROM {S}.opportunity_objective_links ORDER BY id`);
    const again = await apply();
    expect(again.status).toBe(200);
    expect(String(again.body.message)).toContain("Nothing to apply");
    expect((await q(`SELECT id FROM {S}.opportunity_objective_links ORDER BY id`)).rows).toEqual(before.rows);
    expect(await receipts()).toBe(1);
  });

  it("resumes: after a crash that left some links missing and no receipt, a rerun adds only the missing ones, keeps already-linked rows and DIRECT origins", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    // One surviving link is DIRECT: a rerun must neither duplicate nor relabel it.
    await q(`UPDATE {S}.opportunity_objective_links SET origin = 'DIRECT', source = 'UI' WHERE id = (SELECT id FROM {S}.opportunity_objective_links LIMIT 1)`);
    const kept = await q<{ id: string }>(`SELECT id FROM {S}.opportunity_objective_links WHERE origin = 'DIRECT'`);
    const removed = await q(`DELETE FROM {S}.opportunity_objective_links WHERE id IN (SELECT id FROM {S}.opportunity_objective_links WHERE origin = 'LEGACY' LIMIT ${TYPED_LINK_BACKFILL_BATCH_SIZE + 50}) RETURNING id`);
    expect(removed.rows).toHaveLength(TYPED_LINK_BACKFILL_BATCH_SIZE + 50);
    const rerun = await apply();
    expect(rerun.body, JSON.stringify(rerun.body)).not.toHaveProperty("error");
    expect(rerun.status).toBe(200);
    expect(String(rerun.body.message)).toContain(`inserted ${TYPED_LINK_BACKFILL_BATCH_SIZE + 50} LEGACY opportunity_objective_links rows`);
    expect(await linkCount()).toBe(GOOD);
    expect((await q(`SELECT id, origin FROM {S}.opportunity_objective_links WHERE id = $1`, [kept.rows[0].id])).rows).toEqual([{ id: kept.rows[0].id, origin: "DIRECT" }]);
    expect(await receipts()).toBe(1);
  });

  it("postcondition failure fails closed with no receipt, and resumes after repair", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    // A link whose workspace_id disagrees with its endpoints: the backfill never rewrites existing links.
    const victim = (await q<{ id: string }>(`SELECT id FROM {S}.opportunity_objective_links WHERE workspace_id = $1 LIMIT 1`, [WS_A])).rows[0].id;
    await q(`UPDATE {S}.opportunity_objective_links SET workspace_id = $2 WHERE id = $1`, [victim, WS_B]);
    expect((await status()).linkIntegrity?.workspaceMismatch).toBe(1);
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/agreement postcondition failed: 1 opportunity_objective_links rows have a workspace_id that differs/);
    expect(await receipts()).toBe(0);

    await q(`UPDATE {S}.opportunity_objective_links SET workspace_id = $2 WHERE id = $1`, [victim, WS_A]);
    const recovered = await apply();
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(await receipts()).toBe(1);
  });

  it("postcondition failure: a link pointing at a missing endpoint fails closed with no receipt, and resumes after repair", async () => {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [MIGRATION]);
    const ghost = randomUUID();
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1, $2, $3, 'DIRECT')`, [WS_A, ghost, objA]);
    expect((await status()).linkIntegrity?.danglingEndpoint).toBe(1);
    const failed = await apply();
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/endpoint postcondition failed: 1 opportunity_objective_links rows point at a missing endpoint/);
    expect(await receipts()).toBe(0);
    await q(`DELETE FROM {S}.opportunity_objective_links WHERE opportunity_id = $1`, [ghost]);
    expect((await apply()).status).toBe(200);
    expect(await receipts()).toBe(1);
  });

  it("the unique pair index rejects a duplicate link", async () => {
    const existing = (await q<{ opportunity_id: string; objective_id: string }>(`SELECT opportunity_id, objective_id FROM {S}.opportunity_objective_links LIMIT 1`)).rows[0];
    await expect(
      q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'DIRECT')`, [WS_A, existing.opportunity_id, existing.objective_id]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
