import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import {
  AGENT_ACCESS_REQUEST_INDEXES,
  assertAgentAccessRequestsMigration,
} from "@/lib/migrations/agent-access-requests";

type ColumnRow = { table_name: string; column_name: string };

const HEALTHY_COLUMNS: ColumnRow[] = [
  "id",
  "agent_id",
  "workspace_id",
  "requested_access",
  "requested_by_user_id",
  "status",
  "decided_by_user_id",
  "decided_at",
  "created_at",
  "updated_at",
].map((column_name) => ({ table_name: "agent_access_requests", column_name }));

function fakeClient(options: { columns?: ColumnRow[]; indexes?: { name: string; valid: boolean }[] }) {
  const columns = options.columns ?? HEALTHY_COLUMNS;
  const indexes = options.indexes ?? AGENT_ACCESS_REQUEST_INDEXES.map((name) => ({ name, valid: true }));
  return {
    query: async (sql: string) =>
      /information_schema\.columns/i.test(sql) ? { rows: columns } : { rows: indexes },
  } as unknown as PoolClient;
}

describe("assertAgentAccessRequestsMigration", () => {
  it("passes on a complete, valid catalog", async () => {
    await expect(assertAgentAccessRequestsMigration(fakeClient({}), "compass_dev")).resolves.toBeUndefined();
  });

  it("fails when a required column is missing", async () => {
    await expect(
      assertAgentAccessRequestsMigration(
        fakeClient({ columns: HEALTHY_COLUMNS.filter((c) => c.column_name !== "requested_access") }),
        "compass_dev",
      ),
    ).rejects.toThrow(/agent_access_requests\.requested_access/);
  });

  it("fails when an index is missing", async () => {
    await expect(
      assertAgentAccessRequestsMigration(
        fakeClient({ indexes: [{ name: AGENT_ACCESS_REQUEST_INDEXES[0], valid: true }] }),
        "compass_dev",
      ),
    ).rejects.toThrow(/idx_agent_access_requests_workspace_status/);
  });

  it("fails when an async index built but is not valid", async () => {
    await expect(
      assertAgentAccessRequestsMigration(
        fakeClient({ indexes: AGENT_ACCESS_REQUEST_INDEXES.map((name, i) => ({ name, valid: i === 0 })) }),
        "compass_dev",
      ),
    ).rejects.toThrow(/not valid|missing/i);
  });
});

describe("migration 054 registration", () => {
  it("is registered in the runner manifest under its exact name", async () => {
    const { readFileSync } = await import("node:fs");
    const runner = readFileSync("lib/migrations/runner.ts", "utf8");
    expect(runner).toContain('name: "054_agent_access_requests"');
    // Async index DDL in this migration must be waited on before the receipt.
    expect(runner).toMatch(/ASYNC_WAIT_MIGRATIONS[\s\S]{0,400}054_agent_access_requests/);
  });

  it("ships additive DDL only — no drops, no backfill, no FK, and deliberately no uniqueness constraint", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("prisma/migrations/054_agent_access_requests/migration.sql", "utf8");
    // Strip SQL comments before asserting on statement shape — the comment
    // block deliberately documents the "no unique constraint" decision using
    // the word "unique", which would otherwise self-match.
    const sql = raw.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS agent_access_requests/);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    expect(sql).not.toMatch(/UNIQUE/i);
    // DSQL only supports ASYNC index builds.
    for (const statement of sql.split(";")) {
      if (/CREATE\s+(UNIQUE\s+)?INDEX/i.test(statement)) {
        expect(statement).toMatch(/INDEX ASYNC/i);
      }
    }
  });
});
