/**
 * The read-parity status runs inside GET /api/admin/migrate on both backends. Aurora DSQL rejects `SET LOCAL statement_timeout`
 * ("setting configuration parameter ... not supported"), so the statement is issued on plain Postgres only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { READ_PARITY_SPEC_NAMES, getEntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity";

const DB_ENV = ["DATABASE_URL", "POSTGRES_URL", "DATABASE_MIGRATION_URL", "POSTGRES_URL_NON_POOLING", "PREVIEW_AUTOMATION_ENABLED", "PREVIEW_DATABASE_MODE"];

const TABLES = ["task_links", "artifact_links", "opportunity_objective_links", "solution_key_result_links"];

function fakeClient(present: { tables: string[]; column: boolean } = { tables: TABLES, column: true }) {
  const row = { legacy_live: "1", mirror_live: "1", only_legacy: "0", only_legacy_ids: [], only_entity_links: "0", only_entity_links_ids: [], origin_drift: "0", origin_drift_ids: [] };
  const query = vi.fn(async (sql: string) => {
    if (/information_schema\.tables/.test(sql)) return { rows: present.tables.map((table_name) => ({ table_name })), rowCount: present.tables.length };
    if (/information_schema\.columns/.test(sql)) return { rows: [{ n: present.column ? "1" : "0" }], rowCount: 1 };
    return { rows: /^\s*WITH/.test(sql) ? [row] : [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, query };
}

function stubBackend(kind: "postgres" | "dsql") {
  for (const key of DB_ENV) vi.stubEnv(key, "");
  if (kind === "postgres") vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/compass");
}

afterEach(() => vi.unstubAllEnvs());

describe("statement_timeout is backend-aware", () => {
  it("plain Postgres: BEGIN, SET LOCAL statement_timeout, read, COMMIT for every family", async () => {
    stubBackend("postgres");
    const { client, query } = fakeClient();
    const status = await getEntityLinksReadParityStatus(client, "s");
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.filter((sql) => /^SET LOCAL statement_timeout = \d+$/.test(sql))).toHaveLength(READ_PARITY_SPEC_NAMES.length);
    const begin = sqls.indexOf("BEGIN");
    expect(sqls.slice(begin, begin + 4).map((sql) => sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "SET", "WITH", "COMMIT"]);
    expect(status.totalMismatches).toBe(0);
  });

  it("Aurora DSQL: never issues SET, still reads inside BEGIN/COMMIT", async () => {
    stubBackend("dsql");
    const { client, query } = fakeClient();
    const status = await getEntityLinksReadParityStatus(client, "s");
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => /^\s*SET\b/i.test(sql) || /statement_timeout/.test(sql))).toBe(false);
    const begin = sqls.indexOf("BEGIN");
    expect(sqls.slice(begin, begin + 3).map((sql) => sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "WITH", "COMMIT"]);
    expect(status.totalMismatches).toBe(0);
  });

  it("rolls back and rethrows when the read fails", async () => {
    stubBackend("dsql");
    const query = vi.fn(async (sql: string) => {
      if (/^\s*WITH/.test(sql)) throw new Error("boom");
      if (/information_schema\.tables/.test(sql)) return { rows: TABLES.map((table_name) => ({ table_name })), rowCount: 4 };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ n: "1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(getEntityLinksReadParityStatus({ query } as unknown as PoolClient, "s")).rejects.toThrow("boom");
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe("ROLLBACK");
  });
});

describe("after migration 116 dropped the legacy relations", () => {
  it("never queries a dropped table: every family reports legacyDropped with zero counts", async () => {
    stubBackend("postgres");
    const { client, query } = fakeClient({ tables: [], column: false });
    const status = await getEntityLinksReadParityStatus(client, "s");
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => /^\s*WITH/.test(sql))).toBe(false);
    expect(status.totalMismatches).toBe(0);
    expect(status.unmovedTaskOriginLinks).toBe(0);
    expect(Object.values(status.families).every((entry) => entry.legacyDropped === true && entry.onlyLegacy === 0)).toBe(true);
  });

  it("a family is only skipped when ITS source is gone", async () => {
    stubBackend("postgres");
    const { client } = fakeClient({ tables: ["task_links"], column: false });
    const status = await getEntityLinksReadParityStatus(client, "s");
    expect(status.families.taskReferences.legacyDropped).toBeUndefined();
    expect(status.families.taskCreatedFrom.legacyDropped).toBeUndefined();
    expect(status.families.artifactSolution.legacyDropped).toBe(true);
    expect(status.families.opportunityKeyResultPointer.legacyDropped).toBe(true);
  });
});
