/**
 * The read-parity status runs inside GET /api/admin/migrate on both backends. Aurora DSQL rejects `SET LOCAL statement_timeout`
 * ("setting configuration parameter ... not supported"), so the statement is issued on plain Postgres only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { READ_PARITY_SPEC_NAMES, getEntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity";

const DB_ENV = ["DATABASE_URL", "POSTGRES_URL", "DATABASE_MIGRATION_URL", "POSTGRES_URL_NON_POOLING", "PREVIEW_AUTOMATION_ENABLED", "PREVIEW_DATABASE_MODE"];

function fakeClient() {
  const row = { legacy_live: "1", mirror_live: "1", only_legacy: "0", only_legacy_ids: [], only_entity_links: "0", only_entity_links_ids: [], origin_drift: "0", origin_drift_ids: [] };
  const query = vi.fn(async (sql: string) => ({ rows: /^\s*WITH/.test(sql) ? [row] : [], rowCount: 0 }));
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
    expect(sqls.slice(0, 4).map((sql) => sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "SET", "WITH", "COMMIT"]);
    expect(status.totalMismatches).toBe(0);
  });

  it("Aurora DSQL: never issues SET, still reads inside BEGIN/COMMIT", async () => {
    stubBackend("dsql");
    const { client, query } = fakeClient();
    const status = await getEntityLinksReadParityStatus(client, "s");
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => /^\s*SET\b/i.test(sql) || /statement_timeout/.test(sql))).toBe(false);
    expect(sqls.slice(0, 3).map((sql) => sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "WITH", "COMMIT"]);
    expect(status.totalMismatches).toBe(0);
  });

  it("rolls back and rethrows when the read fails", async () => {
    stubBackend("dsql");
    const query = vi.fn(async (sql: string) => {
      if (/^\s*WITH/.test(sql)) throw new Error("boom");
      return { rows: [], rowCount: 0 };
    });
    await expect(getEntityLinksReadParityStatus({ query } as unknown as PoolClient, "s")).rejects.toThrow("boom");
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe("ROLLBACK");
  });
});
