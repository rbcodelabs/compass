import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE,
  ENTITY_LINKS_TASK_LINK_MOVE_MIGRATION,
  assertEntityLinksTaskLinkMove,
  assertEntityLinksTaskLinkMovePreconditions,
  moveTaskLinksToEntityLinks,
} from "@/lib/migrations/entity-links-task-link-move";
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner";
import { LINK_TYPES, TASK_ORIGIN_MOVE_MIGRATION, TASK_ORIGIN_TARGET_TYPES } from "@/lib/links/registry";

const ROOT = process.cwd();
const NAME = "115_entity_links_task_link_move";
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const HOOK = "lib/migrations/entity-links-task-link-move.ts";

describe("115 registration", () => {
  const runner = read("lib/migrations/runner.ts");

  it("uses the next free number, registers last, and its SQL file has no executable statement (DDL-free)", () => {
    expect(ENTITY_LINKS_TASK_LINK_MOVE_MIGRATION).toBe(NAME);
    expect(TASK_ORIGIN_MOVE_MIGRATION).toBe(NAME);
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "114_portal_home_template"'));
    const sql = read(`prisma/migrations/${NAME}/migration.sql`);
    expect(sql.split("\n").filter((line) => line.trim() && !line.trim().startsWith("--"))).toEqual([]);
  });

  it("is explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "116_other" }, { name: NAME }];
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["116_other"]);
    expect(skippedExplicitOnly(pending)).toEqual([NAME]);
    expect(selectMigrationsToRun(pending, NAME).map((m) => m.name)).toEqual([NAME]);
    expect(runner).toMatch(/EXPLICIT_ONLY_MIGRATIONS: readonly string\[\] = \[[^\]]*ENTITY_LINKS_TASK_LINK_MOVE_MIGRATION/);
  });

  it("runs the move and its postconditions before the receipt, needs no async index wait and is in the replay skip list", () => {
    const hook = runner.indexOf("await moveTaskLinksToEntityLinks(client, schema, log)");
    const assertion = runner.indexOf("await assertEntityLinksTaskLinkMove(client, schema)");
    expect(hook).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(hook);
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'));
    expect(runner).not.toMatch(new RegExp(`ASYNC_WAIT_MIGRATIONS = \\[[^\\]]*${NAME}`));
    expect(read("__tests__/helpers/replay-migrations.ts")).toContain(NAME);
  });

  it("is reported by GET /api/admin/migrate before it is POSTed", () => {
    expect(runner).toContain("entityLinksTaskLinkMove: await statusUnlessLegacyDropped(client, schema, LEGACY_STATUS_SOURCES.task, () => getEntityLinksTaskLinkMoveStatus(client, schema))");
  });

  it("is pinned in the managed manifest (SQL and hook)", () => {
    const manifest = read("lib/preview-automation/managed-manifest.ts");
    const digest = (file: string) => createHash("sha256").update(readFileSync(path.join(ROOT, file))).digest("hex");
    expect(manifest).toContain(`"${NAME}": "${digest(`prisma/migrations/${NAME}/migration.sql`)}"`);
    expect(manifest).toContain(`"${HOOK}": "${digest(HOOK)}"`);
  });

  it("is the move the registry type names, and the type carries exactly the two origin kinds", () => {
    expect(LINK_TYPES.TASK_CREATED_FROM.dedicatedWriter?.backfillMigration).toBe(NAME);
    expect([...TASK_ORIGIN_TARGET_TYPES]).toEqual(["COMMENT", "AGENT_CONVERSATION"]);
    const hook = read(HOOK);
    for (const type of TASK_ORIGIN_TARGET_TYPES) expect(hook).toContain(`type: "${type}"`);
  });
});

describe("DSQL safety of the hook (the migration runs against Aurora DSQL as well as Postgres)", () => {
  const code = read(HOOK).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("uses no ON CONFLICT, no multi-array unnest, no DDL, no SET LOCAL / statement_timeout, no advisory lock and no foreign key", () => {
    expect(code).not.toMatch(/ON CONFLICT/i);
    expect(code).not.toMatch(/unnest/i);
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)/i);
    expect(code).not.toMatch(/SET\s+LOCAL|statement_timeout/i);
    expect(code).not.toMatch(/advisory/i);
    expect(code).not.toMatch(/REFERENCES|FOREIGN KEY/i);
  });

  it("is insert-only against task_links and never deletes an entity_links row", () => {
    expect(code).not.toMatch(/(DELETE\s+FROM|UPDATE|INSERT\s+INTO)\s+"\$\{(?:s|schema)\}"\."task_links"/i);
    expect(code).not.toMatch(/DELETE\s+FROM/i);
  });

  it("copies the id, source, actor and creation time, and stamps the task's workspace", () => {
    expect(code).toContain("SELECT l.id, t.workspace_id");
    expect(code).toContain("l.source, l.created_by_id, l.created_at");
  });
});

describe("batch size", () => {
  it("stays inside DSQL's 3,000-row write limit (a row plus three index entries per link)", () => {
    expect(ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE).toBe(500);
    expect(ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE * 4).toBeLessThan(3000);
  });
});

type Reply = { rows?: unknown[]; rowCount?: number };
function fakeClient(handler: (sql: string, params: unknown[]) => Reply) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: [], rowCount: 0, ...handler(sql, params) }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("preconditions fail closed before any write", () => {
  it("refuses when 091 has no receipt", async () => {
    const { client, query } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "0" }] } : {}));
    await expect(assertEntityLinksTaskLinkMovePreconditions(client, "s")).rejects.toThrow(/091_entity_links is not applied/);
    expect(query.mock.calls.every(([sql]) => !/^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });

  it("refuses when a table or column is missing", async () => {
    const { client } = fakeClient((sql) => (sql.includes("_prisma_migrations") ? { rows: [{ n: "1" }] } : { rows: [{ table_name: "tasks" }] }));
    await expect(assertEntityLinksTaskLinkMovePreconditions(client, "s")).rejects.toThrow(/missing a column/);
  });

  it("the move itself performs no write when the precondition fails", async () => {
    const { client, query } = fakeClient(() => ({ rows: [{ n: "0" }] }));
    await expect(moveTaskLinksToEntityLinks(client, "s", [])).rejects.toThrow(/precondition failed/);
    expect(query.mock.calls.every(([sql]) => !/^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(true);
  });
});

describe("postconditions refuse the receipt", () => {
  // Answers every count with 0 except the one whose SQL matches.
  const clientFailing = (marker: RegExp) => fakeClient((sql) => ({ rows: [{ n: marker.test(sql) ? "3" : "0" }] })).client;

  it("passes when every count is zero", async () => {
    await expect(assertEntityLinksTaskLinkMove(clientFailing(/^never$/), "s")).resolves.toBeUndefined();
  });

  it.each([
    ["COMMENT links without a matching row (pair-set equality)", /l\.linked_type = 'COMMENT' AND \(CASE[\s\S]*e\.id IS NULL OR e\.workspace_id <> t\.workspace_id/, /coverage postcondition failed: 3 consistent COMMENT task_links/],
    ["AGENT_CONVERSATION links without a matching row (pair-set equality)", /l\.linked_type = 'AGENT_CONVERSATION' AND \(CASE[\s\S]*e\.id IS NULL OR e\.workspace_id <> t\.workspace_id/, /coverage postcondition failed: 3 consistent AGENT_CONVERSATION task_links/],
    ["a COMMENT row-count mismatch", /count\(DISTINCT e\.id\)[\s\S]*l\.linked_type = 'COMMENT'/, /count postcondition failed for COMMENT/],
    ["an AGENT_CONVERSATION row-count mismatch", /count\(DISTINCT e\.id\)[\s\S]*l\.linked_type = 'AGENT_CONVERSATION'/, /count postcondition failed for AGENT_CONVERSATION/],
    ["duplicate pairs", /GROUP BY from_id, link_type, to_id HAVING count\(\*\) > 1/, /uniqueness postcondition failed/],
    ["a COMMENT workspace mismatch", /e\.to_type = 'COMMENT' AND \(e\.workspace_id <> t\.workspace_id/, /tenant postcondition failed: 3 COMMENT/],
    ["an AGENT_CONVERSATION workspace mismatch", /e\.to_type = 'AGENT_CONVERSATION' AND \(e\.workspace_id <> t\.workspace_id/, /tenant postcondition failed: 3 AGENT_CONVERSATION/],
  ])("%s", async (_label, marker, message) => {
    await expect(assertEntityLinksTaskLinkMove(clientFailing(marker), "s")).rejects.toThrow(message);
  });

  it("a consistent-row count that differs from the covering-row count refuses even when nothing is unmatched", async () => {
    const { client } = fakeClient((sql) => ({ rows: [{ n: /count\(DISTINCT e\.id\)/.test(sql) ? "4" : /l\.linked_type = 'COMMENT' AND \(CASE[\s\S]*\) = 'ok'$/.test(sql.trim()) ? "5" : "0" }] }));
    await expect(assertEntityLinksTaskLinkMove(client, "s")).rejects.toThrow(/count postcondition failed for COMMENT: 5 consistent task_links rows but 4 covering/);
  });
});
