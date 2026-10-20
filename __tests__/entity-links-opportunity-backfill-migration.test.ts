import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE,
  ENTITY_LINKS_OPPORTUNITY_BACKFILL_MIGRATION,
  assertEntityLinksOpportunityBackfill,
  assertEntityLinksOpportunityPreconditions,
  backfillEntityLinksOpportunity,
} from "@/lib/migrations/entity-links-opportunity-backfill";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";
import { LINK_TYPES } from "@/lib/links/registry";

const ROOT = process.cwd();
const NAME = "095_entity_links_backfill_opportunity";
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("095 registration", () => {
  const runner = read("lib/migrations/runner.ts");

  it("uses the next free number, registers after 094, and its SQL file has no executable statement", () => {
    expect(ENTITY_LINKS_OPPORTUNITY_BACKFILL_MIGRATION).toBe(NAME);
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "094_work_item_ids_residual_backfill"'));
    const sql = read(`prisma/migrations/${NAME}/migration.sql`);
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([]);
  });

  it("is explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "096_other" }, { name: NAME }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["096_other"]);
    expect(skippedExplicitOnly(pending)).toEqual([NAME]);
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME]);
    expect(runner).toMatch(/EXPLICIT_ONLY_MIGRATIONS: readonly string\[\] = \[[^\]]*ENTITY_LINKS_OPPORTUNITY_BACKFILL_MIGRATION/);
  });

  it("runs the backfill and its postconditions before the receipt, needs no async index wait and is in the replay skip list", () => {
    const hook = runner.indexOf("await backfillEntityLinksOpportunity(client, schema, log)");
    const assertion = runner.indexOf("await assertEntityLinksOpportunityBackfill(client, schema)");
    expect(hook).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(hook);
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'));
    expect(runner).not.toMatch(new RegExp(`ASYNC_WAIT_MIGRATIONS = \\[[^\\]]*${NAME}`));
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME);
  });

  it("is reported by GET /api/admin/migrate before it is POSTed", () => {
    expect(read("lib/migrations/runner.ts")).toContain("entityLinksOpportunityBackfill: await getEntityLinksOpportunityStatus(client, schema)");
  });

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts");
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`);
    expect(manifest).toContain(`"lib/migrations/entity-links-opportunity-backfill.ts": "${digest("lib/migrations/entity-links-opportunity-backfill.ts")}"`);
  });

  it("is the backfill the two registry types name", () => {
    expect(LINK_TYPES.OPPORTUNITY_TARGETS_OBJECTIVE.legacy?.backfillMigration).toBe(NAME);
    expect(LINK_TYPES.OPPORTUNITY_TARGETS_KEY_RESULT.legacy?.backfillMigration).toBe(NAME);
  });
});

describe("batch size", () => {
  it("stays inside DSQL's 3,000-row write limit (a row plus three index entries per link)", () => {
    expect(ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE).toBe(500);
    expect(ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE * 4).toBeLessThan(3000);
  });
});

type Reply = { rows?: unknown[]; rowCount?: number };
function fakeClient(handler: (sql: string, params: unknown[]) => Reply) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: [], rowCount: 0, ...handler(sql, params) }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("preconditions fail closed before any write", () => {
  it("refuses when a required migration has no receipt", async () => {
    const { client, query } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "0" }] } : {}));
    await expect(assertEntityLinksOpportunityPreconditions(client, "s")).rejects.toThrow(/068_workspace_id_on_solution_objective is not applied/);
    expect(query.mock.calls.every(([sql]) => !/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });

  it("refuses when a table or column is missing", async () => {
    const { client } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "1" }] } : { rows: [{ table_name: "objectives" }] }));
    await expect(assertEntityLinksOpportunityPreconditions(client, "s")).rejects.toThrow(/missing/);
  });

  it("the backfill itself performs no write when the precondition fails", async () => {
    const { client, query } = fakeClient(() => ({ rows: [{ n: "0" }] }));
    await expect(backfillEntityLinksOpportunity(client, "s", [])).rejects.toThrow(/precondition failed/);
    expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });
});

describe("postconditions refuse the receipt", () => {
  // Answers every count with 0 except the one whose SQL matches.
  const clientFailing = (marker: RegExp) => fakeClient((sql) => ({ rows: [{ n: marker.test(sql) ? "3" : "0" }] })).client;

  it("passes when every count is zero", async () => {
    await expect(assertEntityLinksOpportunityBackfill(clientFailing(/^never$/), "s")).resolves.toBeUndefined();
  });

  it.each([
    ["unmatched objective links", /FROM "s"\."opportunity_objective_links" AS l[\s\S]*e\.id IS NULL OR e\.origin <> l\.origin/, /coverage postcondition failed: 3 consistent opportunity_objective_links/],
    ["unmatched pointers", /e\.origin <> 'LEGACY'/, /coverage postcondition failed: 3 consistent linked_key_result_id/],
    ["duplicate pairs", /GROUP BY from_id, link_type, to_id HAVING count\(\*\) > 1/, /uniqueness postcondition failed/],
    ["a second pointer row", /link_type = 'OPPORTUNITY_TARGETS_KEY_RESULT' GROUP BY from_id HAVING/, /cardinality postcondition failed/],
    ["a dangling endpoint", /\(o\.id IS NULL OR obj\.id IS NULL\)/, /integrity postcondition failed/],
    ["a workspace mismatch", /e\.workspace_id IS DISTINCT FROM o\.workspace_id/, /tenant postcondition failed/],
  ])("%s", async (_label, marker, message) => {
    await expect(assertEntityLinksOpportunityBackfill(clientFailing(marker), "s")).rejects.toThrow(message);
  });
});
