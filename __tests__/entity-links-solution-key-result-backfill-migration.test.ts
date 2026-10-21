import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE,
  ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_MIGRATION,
  assertEntityLinksSolutionKeyResultBackfill,
  assertEntityLinksSolutionKeyResultPreconditions,
  backfillEntityLinksSolutionKeyResult,
} from "@/lib/migrations/entity-links-solution-key-result-backfill";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";
import { LINK_TYPES } from "@/lib/links/registry";

const ROOT = process.cwd();
const NAME = "098_entity_links_backfill_solution_key_result";
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("098 registration", () => {
  const runner = read("lib/migrations/runner.ts");

  it("registers after 099, and its SQL file has no executable statement", () => {
    expect(ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_MIGRATION).toBe(NAME);
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "099_agent_owner_user_nullable"'));
    const sql = read(`prisma/migrations/${NAME}/migration.sql`);
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([]);
  });

  it("is explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "100_other" }, { name: NAME }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["100_other"]);
    expect(skippedExplicitOnly(pending)).toEqual([NAME]);
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME]);
    expect(runner).toMatch(/EXPLICIT_ONLY_MIGRATIONS: readonly string\[\] = \[[^\]]*ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_MIGRATION/);
  });

  it("runs the backfill and its postconditions before the receipt, needs no async index wait and is in the replay skip list", () => {
    const hook = runner.indexOf("await backfillEntityLinksSolutionKeyResult(client, schema, log)");
    const assertion = runner.indexOf("await assertEntityLinksSolutionKeyResultBackfill(client, schema)");
    expect(hook).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(hook);
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'));
    expect(runner).not.toMatch(new RegExp(`ASYNC_WAIT_MIGRATIONS = \\[[^\\]]*${NAME}`));
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME);
  });

  it("is reported by GET /api/admin/migrate before it is POSTed", () => {
    expect(read("lib/migrations/runner.ts")).toContain("entityLinksSolutionKeyResultBackfill: await getEntityLinksSolutionKeyResultStatus(client, schema)");
  });

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts");
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`);
    expect(manifest).toContain(`"lib/migrations/entity-links-solution-key-result-backfill.ts": "${digest("lib/migrations/entity-links-solution-key-result-backfill.ts")}"`);
  });

  it("is the backfill the registry type names (no longer new-only)", () => {
    expect(LINK_TYPES.SOLUTION_TARGETS_KEY_RESULT.legacy?.backfillMigration).toBe(NAME);
  });
});

describe("batch size", () => {
  it("stays inside DSQL's 3,000-row write limit (a row plus three index entries per link)", () => {
    expect(ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE).toBe(500);
    expect(ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE * 4).toBeLessThan(3000);
  });
});

describe("SQL carries no ON CONFLICT and copies the live mirror's semantics", () => {
  const hook = read("lib/migrations/entity-links-solution-key-result-backfill.ts");
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("never uses ON CONFLICT and writes origin DIRECT with workspace_id from the Solution", () => {
    expect(code).not.toMatch(/ON CONFLICT/i);
    expect(hook).toContain("SELECT s.workspace_id, '${SOLUTION_KEY_RESULT_KEY}', 'SOLUTION', l.solution_id, 'KEY_RESULT', l.key_result_id, 'DIRECT', l.source, l.created_by_id, l.created_at");
  });
});

type Reply = { rows?: unknown[]; rowCount?: number };
function fakeClient(handler: (sql: string, params: unknown[]) => Reply) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: [], rowCount: 0, ...handler(sql, params) }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("preconditions fail closed before any write", () => {
  it.each(["068_workspace_id_on_solution_objective", "071_typed_link_tables", "091_entity_links"])("refuses when %s has no receipt", async (missing) => {
    const { client, query } = fakeClient((sql, params) => (sql.includes("_prisma_migrations") ? { rows: [{ n: params[0] === missing ? "0" : "1" }] } : {}));
    await expect(assertEntityLinksSolutionKeyResultPreconditions(client, "s")).rejects.toThrow(new RegExp(`${missing} is not applied`));
    expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });

  it("refuses when a table or column is missing", async () => {
    const { client } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "1" }] } : { rows: [{ table_name: "objectives" }] }));
    await expect(assertEntityLinksSolutionKeyResultPreconditions(client, "s")).rejects.toThrow(/missing/);
  });

  it("the backfill itself performs no write when the precondition fails", async () => {
    const { client, query } = fakeClient(() => ({ rows: [{ n: "0" }] }));
    await expect(backfillEntityLinksSolutionKeyResult(client, "s", [])).rejects.toThrow(/precondition failed/);
    expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });
});

describe("postconditions refuse the receipt", () => {
  // Answers every count with 0 except the one whose SQL matches.
  const clientFailing = (marker: RegExp) => fakeClient((sql) => ({ rows: [{ n: marker.test(sql) ? "3" : "0" }] })).client;

  it("passes when every count is zero", async () => {
    await expect(assertEntityLinksSolutionKeyResultBackfill(clientFailing(/^never$/), "s")).resolves.toBeUndefined();
  });

  it.each([
    ["unmatched links", /e\.id IS NULL OR e\.workspace_id <> s\.workspace_id/, /coverage postcondition failed: 3 consistent solution_key_result_links/],
    ["duplicate pairs", /GROUP BY from_id, link_type, to_id HAVING count\(\*\) > 1/, /uniqueness postcondition failed/],
    ["a dangling endpoint", /\(s\.id IS NULL OR kr\.id IS NULL OR obj\.id IS NULL\)/, /integrity postcondition failed/],
    ["a workspace mismatch", /e\.workspace_id IS DISTINCT FROM s\.workspace_id/, /tenant postcondition failed/],
  ])("%s", async (_label, marker, message) => {
    await expect(assertEntityLinksSolutionKeyResultBackfill(clientFailing(marker), "s")).rejects.toThrow(message);
  });
});
