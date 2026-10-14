/**
 * Runs the REGISTERED migration 072 (and its prerequisites 068 and 071) through the real runner
 * (`applyMigrations`) against a throwaway schema in the local compass_e2e database. Never touches
 * Aurora or any shared environment; the schema is dropped in afterAll. Skipped without a URL:
 *
 *   TYPED_LINK_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/typed-links-residual-migration.integration.test.ts
 *
 * 072 has no DDL. It re-runs 071's idempotent backfill after the dual-writing code is live, so old
 * instances' writes (a pointer set or changed without its LEGACY link) are caught up. DIRECT links are
 * the user's: never deleted, and when one has a missing endpoint or a workspace mismatch it is REPORTED
 * (linkIntegrity.directDangling / directWorkspaceMismatch) and does not fail the receipt. LEGACY links are
 * derived data: stale ones are pruned and the postconditions still fail closed on them.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner";
import { getTypedLinkStatus } from "@/lib/migrations/typed-link-tables";

const RESIDUAL = "072_typed_links_residual_backfill";
const LINK_TABLES = "071_typed_link_tables";
const WORKSPACE_ID = "068_workspace_id_on_solution_objective";
const databaseUrl = process.env.TYPED_LINK_TEST_DATABASE_URL ?? process.env.WORKSPACE_ID_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("072 typed links residual backfill (registered migration)", () => {
  const schema = `tlres_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const previous = process.env.DATABASE_URL;
  const WS_A = randomUUID();
  const WS_B = randomUUID();
  const q = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    pool.query<T>(sql.replaceAll("{S}", `"${schema}"`), params);

  async function apply(script: string) {
    const response = await applyMigrations(pool, schema, script);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const receipts = async (name: string) =>
    Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [name])).rows[0].n);
  const attempts = async (name: string) => Number((await q(`SELECT count(*)::int AS n FROM {S}._prisma_migrations WHERE migration_name = $1`, [name])).rows[0].n);
  const linkRows = async (opportunityId: string) =>
    (await q<{ workspace_id: string; objective_id: string; origin: string }>(`SELECT workspace_id, objective_id, origin FROM {S}.opportunity_objective_links WHERE opportunity_id = $1 ORDER BY objective_id`, [opportunityId])).rows;
  const linkCount = async () => Number((await q(`SELECT count(*)::int AS n FROM {S}.opportunity_objective_links`)).rows[0].n);
  async function status() {
    const client = await pool.connect();
    try {
      return await getTypedLinkStatus(client, schema);
    } finally {
      client.release();
    }
  }
  /** What a POST of 072 does: drop its receipt (as if it had never run) and apply it. */
  async function runResidual() {
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [RESIDUAL]);
    const result = await apply(RESIDUAL);
    return { ...result, message: String(result.body.message ?? ""), error: String(result.body.error ?? "") };
  }
  const opportunity = async (workspace: string, keyResultId: string | null, title = "opp") => {
    const id = randomUUID();
    await q(`INSERT INTO {S}.opportunities (id, workspace_id, title, linked_key_result_id) VALUES ($1, $2, $3, $4)`, [id, workspace, title, keyResultId]);
    return id;
  };

  let objA1: string;
  let objA2: string;
  let objB: string;
  let krA1: string;
  let krA2: string;
  let krB: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database");
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const init = await applyMigrations(pool, schema, "001_init");
    expect(init.status, JSON.stringify(await init.json())).toBe(200);
    // 068 first: the objectives below carry their own workspace_id, as every writer shipped with it does.
    const prerequisite = await applyMigrations(pool, schema, WORKSPACE_ID);
    expect(prerequisite.status, JSON.stringify(await prerequisite.json())).toBe(200);

    const [cycleA, cycleB] = [randomUUID(), randomUUID()];
    [objA1, objA2, objB] = [randomUUID(), randomUUID(), randomUUID()];
    [krA1, krA2, krB] = [randomUUID(), randomUUID(), randomUUID()];
    await q(`INSERT INTO {S}.okr_cycles (id, workspace_id, title, start_date, end_date) VALUES ($1,$2,'A','2026-01-01','2026-03-31'), ($3,$4,'B','2026-01-01','2026-03-31')`, [cycleA, WS_A, cycleB, WS_B]);
    await q(`INSERT INTO {S}.objectives (id, cycle_id, title, workspace_id) VALUES ($1,$2,'obj A1',$3), ($4,$2,'obj A2',$3), ($5,$6,'obj B',$7)`, [objA1, cycleA, WS_A, objA2, objB, cycleB, WS_B]);
    await q(`INSERT INTO {S}.key_results (id, objective_id, title, target) VALUES ($1,$2,'kr A1',1), ($3,$4,'kr A2',1), ($5,$6,'kr B',1)`, [krA1, objA1, krA2, objA2, krB, objB]);
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

  it("is refused, with no receipt, no attempt row and no change, until 071 is applied", async () => {
    const before = await apply(RESIDUAL);
    expect(before.status).toBe(500);
    expect(String(before.body.error)).toMatch(/^072_typed_links_residual_backfill: precondition failed: 071_typed_link_tables is not applied/);
    expect(await receipts(RESIDUAL)).toBe(0);
    expect(await attempts(RESIDUAL)).toBe(0);
    expect((await apply(LINK_TABLES)).status).toBe(200);
  });

  it("catches up what old instances wrote after 071: a pointer without its link gets a LEGACY link", async () => {
    const stale = await opportunity(WS_A, krA1, "written by old code after 071");
    expect(await linkRows(stale)).toEqual([]);
    const result = await runResidual();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.message).toContain("inserted 1 LEGACY opportunity_objective_links rows");
    expect(await linkRows(stale)).toEqual([{ workspace_id: WS_A, objective_id: objA1, origin: "LEGACY" }]);
    expect(await receipts(RESIDUAL)).toBe(1);
    expect(await attempts(RESIDUAL)).toBe(1);
  });

  it("the residual receipt is its own: 071's receipt and links are untouched by rerunning 072", async () => {
    expect(await receipts(LINK_TABLES)).toBe(1);
    const before = await linkCount();
    const again = await apply(RESIDUAL);
    expect(again.status).toBe(200);
    expect(String(again.body.message)).toContain("Nothing to apply");
    expect(await linkCount()).toBe(before);
  });

  it("rerun after old-code writes: a cleared pointer prunes its LEGACY link, a changed pointer moves it, and DIRECT links are never touched", async () => {
    const cleared = await opportunity(WS_A, krA1, "pointer later cleared");
    const moved = await opportunity(WS_A, krA1, "pointer later changed");
    const direct = await opportunity(WS_A, krA1, "has a DIRECT link too");
    expect((await runResidual()).status).toBe(200);
    expect(await linkRows(cleared)).toEqual([{ workspace_id: WS_A, objective_id: objA1, origin: "LEGACY" }]);

    // The new code's tools made a DIRECT link on an opportunity that has no pointer at all, and flipped one pair to DIRECT.
    const onlyDirect = await opportunity(WS_A, null, "only a DIRECT link");
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin, source) VALUES ($1,$2,$3,'DIRECT','MCP')`, [WS_A, onlyDirect, objA2]);
    await q(`UPDATE {S}.opportunity_objective_links SET origin = 'DIRECT' WHERE opportunity_id = $1`, [direct]);

    // Old instances: clear one pointer, repoint another, clear the pointer of the opportunity whose link was flipped to DIRECT.
    await q(`UPDATE {S}.opportunities SET linked_key_result_id = NULL WHERE id = ANY($1::uuid[])`, [[cleared, direct]]);
    await q(`UPDATE {S}.opportunities SET linked_key_result_id = $2 WHERE id = $1`, [moved, krA2]);
    const result = await runResidual();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.message).toContain("pruned 2 stale LEGACY opportunity_objective_links rows");
    expect(await linkRows(cleared)).toEqual([]);
    expect(await linkRows(moved)).toEqual([{ workspace_id: WS_A, objective_id: objA2, origin: "LEGACY" }]);
    expect(await linkRows(direct)).toEqual([{ workspace_id: WS_A, objective_id: objA1, origin: "DIRECT" }]);
    expect(await linkRows(onlyDirect)).toEqual([{ workspace_id: WS_A, objective_id: objA2, origin: "DIRECT" }]);
  });

  it("a rerun after nothing changed inserts and prunes nothing, and the integrity counts are all zero", async () => {
    const result = await runResidual();
    expect(result.message).toContain("pruned 0 stale LEGACY opportunity_objective_links rows");
    expect(result.message).toContain("inserted 0 LEGACY opportunity_objective_links rows");
    expect((await status()).linkIntegrity).toMatchObject({ legacyWithoutLink: 0, workspaceMismatch: 0, danglingEndpoint: 0, directDangling: 0, directWorkspaceMismatch: 0, duplicates: 0 });
  });

  it("DECISION: DIRECT links with a missing endpoint or a workspace mismatch are REPORTED, kept, and do not fail the receipt", async () => {
    const mismatchOpp = await opportunity(WS_A, null, "direct, drifted workspace");
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'DIRECT')`, [WS_B, mismatchOpp, objA1]);
    const ghostOpp = randomUUID();
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'DIRECT')`, [WS_A, ghostOpp, objA1]);
    const ghostObjectiveOpp = await opportunity(WS_A, null, "direct, objective deleted");
    const ghostObjective = randomUUID();
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'DIRECT')`, [WS_A, ghostObjectiveOpp, ghostObjective]);
    await q(`INSERT INTO {S}.solution_key_result_links (workspace_id, solution_id, key_result_id) VALUES ($1,$2,$3)`, [WS_A, randomUUID(), krA1]);

    expect((await status()).linkIntegrity).toMatchObject({ workspaceMismatch: 0, danglingEndpoint: 0, directWorkspaceMismatch: 1, directDangling: 3 });
    const result = await runResidual();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.message).toContain("reported 3 DIRECT/solution links with a missing endpoint and 1 with a workspace mismatch");
    expect(await receipts(RESIDUAL)).toBe(1);

    // Never silently deleted or rewritten.
    expect(await linkRows(mismatchOpp)).toEqual([{ workspace_id: WS_B, objective_id: objA1, origin: "DIRECT" }]);
    expect(await linkRows(ghostOpp)).toEqual([{ workspace_id: WS_A, objective_id: objA1, origin: "DIRECT" }]);
    expect(await linkRows(ghostObjectiveOpp)).toEqual([{ workspace_id: WS_A, objective_id: ghostObjective, origin: "DIRECT" }]);
    expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.solution_key_result_links`)).rows[0].n)).toBe(1);

    // Visible on the status endpoint a human reads after the POST.
    const body = (await (await getMigrationStatus(pool, schema)).json()) as { linkIntegrity: Record<string, number> };
    expect(body.linkIntegrity).toMatchObject({ directWorkspaceMismatch: 1, directDangling: 3, workspaceMismatch: 0, danglingEndpoint: 0 });

    for (const id of [mismatchOpp, ghostOpp, ghostObjectiveOpp]) await q(`DELETE FROM {S}.opportunity_objective_links WHERE opportunity_id = $1`, [id]);
    await q(`DELETE FROM {S}.solution_key_result_links`);
    expect((await status()).linkIntegrity).toMatchObject({ directWorkspaceMismatch: 0, directDangling: 0 });
  });

  it("LEGACY rows are still held to the postconditions: a LEGACY link with a missing endpoint or a drifted workspace is pruned and re-derived", async () => {
    const drifted = await opportunity(WS_A, krA1, "legacy link drifted to B");
    expect((await runResidual()).status).toBe(200);
    await q(`UPDATE {S}.opportunity_objective_links SET workspace_id = $2 WHERE opportunity_id = $1`, [drifted, WS_B]);
    const ghost = randomUUID();
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'LEGACY')`, [WS_A, ghost, objA1]);
    expect((await status()).linkIntegrity).toMatchObject({ workspaceMismatch: 1, danglingEndpoint: 1, directWorkspaceMismatch: 0, directDangling: 0 });

    const result = await runResidual();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.message).toContain("pruned 2 stale LEGACY opportunity_objective_links rows");
    expect(result.message).toContain("inserted 1 LEGACY opportunity_objective_links rows");
    expect(await linkRows(drifted)).toEqual([{ workspace_id: WS_A, objective_id: objA1, origin: "LEGACY" }]);
    expect(await linkRows(ghost)).toEqual([]);
  });

  it("quarantines a cross-workspace pointer written by old code: never linked, pointer untouched, receipt written", async () => {
    const cross = await opportunity(WS_A, krB, "points at B's key result");
    const result = await runResidual();
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.message).toContain("quarantined 1 cross-workspace");
    expect(result.message).toContain(cross);
    expect(await linkRows(cross)).toEqual([]);
    expect(Number((await q(`SELECT count(*)::int AS n FROM {S}.opportunities WHERE id = $1 AND linked_key_result_id IS NOT NULL`, [cross])).rows[0].n)).toBe(1);
    await q(`UPDATE {S}.opportunities SET linked_key_result_id = NULL WHERE id = $1`, [cross]);
  });

  it("fails closed, naming 072, while a pointer references an objective with a NULL workspace_id, and resumes after repair", async () => {
    const pointed = await opportunity(WS_B, krB, "behind a NULL objective");
    await q(`UPDATE {S}.objectives SET workspace_id = NULL WHERE id = $1`, [objB]);
    await q(`DELETE FROM {S}._prisma_migrations WHERE migration_name = $1`, [RESIDUAL]);
    const before = await linkCount();
    const failed = await apply(RESIDUAL);
    expect(failed.status).toBe(500);
    expect(String(failed.body.error)).toMatch(/^072_typed_links_residual_backfill: precondition failed: \d+ objectives rows have a NULL workspace_id/);
    expect(await receipts(RESIDUAL)).toBe(0);
    expect(await linkCount()).toBe(before);

    await q(`UPDATE {S}.objectives SET workspace_id = $2 WHERE id = $1`, [objB, WS_B]);
    const recovered = await apply(RESIDUAL);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(await linkRows(pointed)).toEqual([{ workspace_id: WS_B, objective_id: objB, origin: "LEGACY" }]);
    expect(await receipts(RESIDUAL)).toBe(1);
  });
});
