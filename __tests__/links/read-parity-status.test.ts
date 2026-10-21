/**
 * entityLinksReadParity in GET /api/admin/migrate (entity_links read flip, PR A): per family, LIVE legacy rows vs LIVE mirror rows in SQL.
 *
 * Part 1 (always runs): registration and shape. Part 2 (needs a throwaway Postgres, any version >= 12): the real SQL against a minimal
 * schema holding only the columns the status reads, seeded with the cases the flip must survive.
 *
 *   READ_PARITY_TEST_DATABASE_URL=postgresql://postgres@localhost:5499/t npx vitest run __tests__/links/read-parity-status.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READ_PARITY_SPEC_NAMES, getEntityLinksReadParityStatus, readParitySetsSql } from "@/lib/migrations/entity-links-read-parity";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

describe("registration and shape", () => {
  it("is reported by GET /api/admin/migrate next to the three backfill statuses", () => {
    const runner = read("lib/migrations/runner.ts");
    expect(runner).toContain("entityLinksReadParity: await getEntityLinksReadParityStatus(client, schema)");
    expect(runner.indexOf("entityLinksReadParity")).toBeGreaterThan(runner.indexOf("entityLinksTaskBackfill"));
  });

  it("covers every legacy-backed link type exactly once and writes nothing", () => {
    expect([...READ_PARITY_SPEC_NAMES].sort()).toEqual(["artifactDecision", "artifactSolution", "opportunityKeyResultPointer", "opportunityObjective", "solutionKeyResult", "taskReferences"]);
    const source = read("lib/migrations/entity-links-read-parity.ts");
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b\s/);
    for (const name of READ_PARITY_SPEC_NAMES) {
      const { legacy, mirror } = readParitySetsSql(name, "s");
      expect(legacy).toMatch(/workspace_id/);
      expect(mirror).toContain('"s"."entity_links"');
    }
  });

  it("task references exclude COMMENT by omission and map DECISION to the stored REVIEW_REQUEST", () => {
    const { legacy, mirror } = readParitySetsSql("taskReferences", "s");
    expect(legacy).not.toContain("'COMMENT'");
    expect(legacy).toContain("l.linked_type = 'DECISION'");
    expect(legacy).toContain("'REVIEW_REQUEST' AS tt");
    expect(mirror).toContain("e.to_type = 'REVIEW_REQUEST'");
  });
});

const databaseUrl = process.env.READ_PARITY_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("against a real Postgres", () => {
  const schema = `parity_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const [WS_A, WS_B] = [randomUUID(), randomUUID()];
  const id = () => randomUUID();
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params);

  const ws = { solA: id(), solB: id(), oppA: id(), oppB: id(), objA: id(), objB: id(), krA: id(), krB: id(), krA2: id(), artA: id(), tskA: id(), tskB: id(), rrTracked: id(), rrOther: id(), docA: id() };

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await q(`
      CREATE TABLE {S}.solutions (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.opportunities (id uuid PRIMARY KEY, workspace_id uuid, linked_key_result_id uuid);
      CREATE TABLE {S}.objectives (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.key_results (id uuid PRIMARY KEY, objective_id uuid);
      CREATE TABLE {S}.artifacts (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.tasks (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.roadmap_items (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.docs (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.experiments (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.feedback (id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE {S}.review_requests (id uuid PRIMARY KEY, workspace_id uuid, gate_type varchar(40));
      CREATE TABLE {S}.solution_key_result_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, solution_id uuid, key_result_id uuid);
      CREATE TABLE {S}.opportunity_objective_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, opportunity_id uuid, objective_id uuid, origin varchar(20));
      CREATE TABLE {S}.artifact_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, artifact_id uuid, linked_type varchar(30), linked_id uuid);
      CREATE TABLE {S}.task_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid, linked_type varchar(30), linked_id uuid);
      CREATE TABLE {S}.entity_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, link_type varchar(60), from_type varchar(40), from_id uuid, to_type varchar(40), to_id uuid, origin varchar(20) DEFAULT 'DIRECT');`);
    const ins = (table: string, cols: string[], values: unknown[]) => q(`INSERT INTO {S}.${table} (${cols.join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`, values);
    for (const [table, rows] of Object.entries({
      solutions: [[ws.solA, WS_A], [ws.solB, WS_B]], opportunities: [[ws.oppA, WS_A, null], [ws.oppB, WS_B, null]], objectives: [[ws.objA, WS_A], [ws.objB, WS_B]],
      artifacts: [[ws.artA, WS_A]], tasks: [[ws.tskA, WS_A], [ws.tskB, WS_B]], docs: [[ws.docA, WS_A]],
    })) for (const row of rows) await ins(table, table === "opportunities" ? ["id", "workspace_id", "linked_key_result_id"] : ["id", "workspace_id"], row);
    for (const [k, o] of [[ws.krA, ws.objA], [ws.krA2, ws.objA], [ws.krB, ws.objB]]) await ins("key_results", ["id", "objective_id"], [k, o]);
    await ins("review_requests", ["id", "workspace_id", "gate_type"], [ws.rrTracked, WS_A, "TRACKED_DECISION"]);
    await ins("review_requests", ["id", "workspace_id", "gate_type"], [ws.rrOther, WS_A, "PRODUCT_LAUNCH"]);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  const mirror = (linkType: string, fromType: string, fromId: string, toType: string, toId: string, origin = "DIRECT", workspaceId = WS_A) =>
    q(`INSERT INTO {S}.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id, origin) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [workspaceId, linkType, fromType, fromId, toType, toId, origin]);
  const status = async () => {
    const client = await pool.connect();
    try { return await getEntityLinksReadParityStatus(client as never, schema); } finally { client.release(); }
  };

  it("an empty database is in parity, every count is a plain number and the modes are reported", async () => {
    const result = await status();
    expect(result.totalMismatches).toBe(0);
    expect(Object.keys(result.families).sort()).toEqual([...READ_PARITY_SPEC_NAMES].sort());
    expect(result.readModes).toEqual({ SOLUTION_KR: "off", OPPORTUNITY: "off", ARTIFACT: "off", TASK: "off" });
    for (const entry of Object.values(result.families)) expect(entry).toMatchObject({ legacyLive: 0, mirrorLive: 0, onlyLegacy: 0, onlyEntityLinks: 0, originDrift: 0 });
  });

  it("matched rows are in parity; dangling, cross-workspace, COMMENT and non-tracked decisions are absent on both sides", async () => {
    const dangling = id();
    // Solution-KR: one good pair; a dangling key result and a cross-workspace key result on both sides.
    for (const kr of [ws.krA, dangling, ws.krB]) {
      await q(`INSERT INTO {S}.solution_key_result_links (workspace_id, solution_id, key_result_id) VALUES ($1,$2,$3)`, [WS_A, ws.solA, kr]);
      await mirror("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", ws.solA, "KEY_RESULT", kr);
    }
    // Opportunity-Objective with origin, and the pointer.
    await q(`INSERT INTO {S}.opportunity_objective_links (workspace_id, opportunity_id, objective_id, origin) VALUES ($1,$2,$3,'DIRECT')`, [WS_A, ws.oppA, ws.objA]);
    await mirror("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", ws.oppA, "OBJECTIVE", ws.objA, "DIRECT");
    await q(`UPDATE {S}.opportunities SET linked_key_result_id = $1 WHERE id = $2`, [ws.krA, ws.oppA]);
    await mirror("OPPORTUNITY_TARGETS_KEY_RESULT", "OPPORTUNITY", ws.oppA, "KEY_RESULT", ws.krA, "LEGACY");
    // Artifact: a solution link and a tracked decision link match; a non-tracked decision is absent on both.
    await q(`INSERT INTO {S}.artifact_links (workspace_id, artifact_id, linked_type, linked_id) VALUES ($1,$2,'SOLUTION',$3),($1,$2,'REVIEW_REQUEST',$4),($1,$2,'REVIEW_REQUEST',$5)`, [WS_A, ws.artA, ws.solA, ws.rrTracked, ws.rrOther]);
    await mirror("ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", ws.artA, "SOLUTION", ws.solA);
    await mirror("ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", ws.artA, "REVIEW_REQUEST", ws.rrTracked);
    await mirror("ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", ws.artA, "REVIEW_REQUEST", ws.rrOther);
    // Tasks: DECISION alias, a plain target, a COMMENT (legacy-only), a cross-workspace target (absent on both sides).
    await q(`INSERT INTO {S}.task_links (task_id, linked_type, linked_id) VALUES ($1,'DECISION',$2),($1,'OPPORTUNITY',$3),($1,'COMMENT',$4),($1,'SOLUTION',$5)`, [ws.tskA, ws.rrTracked, ws.oppA, id(), ws.solB]);
    await mirror("TASK_REFERENCES", "TASK", ws.tskA, "REVIEW_REQUEST", ws.rrTracked);
    await mirror("TASK_REFERENCES", "TASK", ws.tskA, "OPPORTUNITY", ws.oppA);
    await mirror("TASK_REFERENCES", "TASK", ws.tskA, "SOLUTION", ws.solB);

    const result = await status();
    expect(result.totalMismatches).toBe(0);
    expect(result.families.solutionKeyResult).toMatchObject({ legacyLive: 1, mirrorLive: 1 });
    expect(result.families.opportunityObjective).toMatchObject({ legacyLive: 1, mirrorLive: 1 });
    expect(result.families.opportunityKeyResultPointer).toMatchObject({ legacyLive: 1, mirrorLive: 1 });
    expect(result.families.artifactSolution).toMatchObject({ legacyLive: 1, mirrorLive: 1 });
    expect(result.families.artifactDecision).toMatchObject({ legacyLive: 1, mirrorLive: 1 });
    expect(result.families.taskReferences).toMatchObject({ legacyLive: 2, mirrorLive: 2 });
  });

  it("drift both ways, origin drift and a legacy-dangling task link are counted with capped ids", async () => {
    // legacy-only: a Solution-KR row with no mirror; a task link to a missing opportunity is NOT live, so it is not counted.
    await q(`INSERT INTO {S}.solution_key_result_links (workspace_id, solution_id, key_result_id) VALUES ($1,$2,$3)`, [WS_A, ws.solA, ws.krA2]);
    // mirror-only: an artifact solution mirror row whose legacy row is gone.
    await q(`DELETE FROM {S}.artifact_links WHERE linked_type = 'SOLUTION'`);
    // origin drift: legacy DIRECT, mirror LEGACY.
    await q(`UPDATE {S}.entity_links SET origin = 'LEGACY' WHERE link_type = 'OPPORTUNITY_TARGETS_OBJECTIVE'`);
    await q(`INSERT INTO {S}.task_links (task_id, linked_type, linked_id) VALUES ($1,'OPPORTUNITY',$2)`, [ws.tskA, id()]);
    const result = await status();
    expect(result.families.solutionKeyResult).toMatchObject({ onlyLegacy: 1, onlyEntityLinks: 0 });
    expect(result.families.artifactSolution).toMatchObject({ onlyLegacy: 0, onlyEntityLinks: 1 });
    expect(result.families.opportunityObjective).toMatchObject({ originDrift: 1, onlyLegacy: 0, onlyEntityLinks: 0 });
    expect(result.families.taskReferences).toMatchObject({ onlyLegacy: 0, onlyEntityLinks: 0 });
    expect(result.totalMismatches).toBe(3);
    expect(result.families.solutionKeyResult.ids.onlyLegacy).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/title|content/i);
  });

  it("ids are capped", async () => {
    for (let i = 0; i < 30; i += 1) {
      const kr = id();
      await q(`INSERT INTO {S}.key_results (id, objective_id) VALUES ($1,$2)`, [kr, ws.objA]);
      await q(`INSERT INTO {S}.solution_key_result_links (workspace_id, solution_id, key_result_id) VALUES ($1,$2,$3)`, [WS_A, ws.solA, kr]);
    }
    const entry = (await status()).families.solutionKeyResult;
    expect(entry.onlyLegacy).toBe(31);
    expect(entry.ids.onlyLegacy).toHaveLength(20);
  });
});
