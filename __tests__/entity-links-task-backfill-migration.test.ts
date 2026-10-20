import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE,
  ENTITY_LINKS_TASK_BACKFILL_MIGRATION,
  assertEntityLinksTaskBackfill,
  assertEntityLinksTaskPreconditions,
  backfillEntityLinksTask,
} from "@/lib/migrations/entity-links-task-backfill";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";
import { LINK_TYPES } from "@/lib/links/registry";

const ROOT = process.cwd();
const NAME = "097_entity_links_backfill_task";
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("097 registration", () => {
  const runner = read("lib/migrations/runner.ts");

  it("uses the reserved number, registers after 095, and its SQL file has no executable statement", () => {
    expect(ENTITY_LINKS_TASK_BACKFILL_MIGRATION).toBe(NAME);
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "095_entity_links_backfill_opportunity"'));
    const sql = read(`prisma/migrations/${NAME}/migration.sql`);
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([]);
  });

  it("is explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "098_other" }, { name: NAME }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["098_other"]);
    expect(skippedExplicitOnly(pending)).toEqual([NAME]);
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME]);
    expect(runner).toMatch(/EXPLICIT_ONLY_MIGRATIONS: readonly string\[\] = \[[^\]]*ENTITY_LINKS_TASK_BACKFILL_MIGRATION/);
  });

  it("runs the backfill and its postconditions before the receipt, needs no async index wait and is in the replay skip list", () => {
    const hook = runner.indexOf("await backfillEntityLinksTask(client, schema, log)");
    const assertion = runner.indexOf("await assertEntityLinksTaskBackfill(client, schema)");
    expect(hook).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(hook);
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'));
    expect(runner).not.toMatch(new RegExp(`ASYNC_WAIT_MIGRATIONS = \\[[^\\]]*${NAME}`));
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME);
  });

  it("is reported by GET /api/admin/migrate before it is POSTed", () => {
    expect(read("lib/migrations/runner.ts")).toContain("entityLinksTaskBackfill: await getEntityLinksTaskStatus(client, schema)");
  });

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts");
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`);
    expect(manifest).toContain(`"lib/migrations/entity-links-task-backfill.ts": "${digest("lib/migrations/entity-links-task-backfill.ts")}"`);
  });

  it("is the backfill the registry type names", () => {
    expect(LINK_TYPES.TASK_REFERENCES.legacy?.backfillMigration).toBe(NAME);
  });

  it("names all nine legacy target types and stores DECISION as REVIEW_REQUEST", () => {
    const hook = read("lib/migrations/entity-links-task-backfill.ts");
    for (const type of ["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM", "DECISION"]) {
      expect(hook).toContain(`legacy: "${type}"`);
    }
    expect(hook).toContain('legacy: "DECISION", stored: "REVIEW_REQUEST"');
  });

  it("uses no ON CONFLICT, no multi-array unnest and no DDL", () => {
    const hook = read("lib/migrations/entity-links-task-backfill.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(hook).not.toMatch(/ON CONFLICT/i);
    expect(hook).not.toMatch(/unnest/i);
    expect(hook).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)/i);
  });
});

describe("batch size", () => {
  it("stays inside DSQL's 3,000-row write limit (a row plus three index entries per link)", () => {
    expect(ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE).toBe(500);
    expect(ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE * 4).toBeLessThan(3000);
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
    await expect(assertEntityLinksTaskPreconditions(client, "s")).rejects.toThrow(/068_workspace_id_on_solution_objective is not applied/);
    expect(query.mock.calls.every(([sql]) => !/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });

  it("refuses when a table or column is missing", async () => {
    const { client } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "1" }] } : { rows: [{ table_name: "objectives" }] }));
    await expect(assertEntityLinksTaskPreconditions(client, "s")).rejects.toThrow(/missing a column/);
  });

  it("the backfill itself performs no write when the precondition fails", async () => {
    const { client, query } = fakeClient(() => ({ rows: [{ n: "0" }] }));
    await expect(backfillEntityLinksTask(client, "s", [])).rejects.toThrow(/precondition failed/);
    expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });
});

describe("postconditions refuse the receipt", () => {
  // Answers every count with 0 except the one whose SQL matches.
  const clientFailing = (marker: RegExp) => fakeClient((sql) => ({ rows: [{ n: marker.test(sql) ? "3" : "0" }] })).client;

  it("passes when every count is zero", async () => {
    await expect(assertEntityLinksTaskBackfill(clientFailing(/^never$/), "s")).resolves.toBeUndefined();
  });

  it.each([
    ["unmatched links of one target type", /l\.linked_type = 'DOC' AND \(CASE[\s\S]*e\.id IS NULL OR e\.origin <> 'DIRECT'/, /coverage postcondition failed: 3 consistent task_links/],
    ["unmatched links of the DECISION type", /l\.linked_type = 'DECISION' AND \(CASE[\s\S]*e\.to_type <> 'REVIEW_REQUEST'/, /coverage postcondition failed/],
    ["duplicate pairs", /GROUP BY from_id, link_type, to_id HAVING count\(\*\) > 1/, /uniqueness postcondition failed/],
    ["a dangling endpoint with no legacy row", /AND l\.id IS NULL AND \(tk\.id IS NULL OR NOT/, /integrity postcondition failed/],
    ["a workspace mismatch", /e\.workspace_id IS DISTINCT FROM tk\.workspace_id/, /tenant postcondition failed/],
  ])("%s", async (_label, marker, message) => {
    await expect(assertEntityLinksTaskBackfill(clientFailing(marker), "s")).rejects.toThrow(message);
  });
});
