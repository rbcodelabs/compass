import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import {
  SHARED_FIELD_OPTION_SET_INDEXES,
  assertSharedFieldOptionSetsMigration,
} from "@/lib/migrations/shared-field-option-sets";

type ColumnRow = {
  table_name: string;
  column_name: string;
  is_nullable: string;
  column_default: string | null;
};

const HEALTHY_COLUMNS: ColumnRow[] = [
  ...[
    "id",
    "workspace_id",
    "name",
    "options",
    "created_at",
    "updated_at",
    "created_by_id",
    "updated_by_id",
    "source",
  ].map((column_name) => ({
    table_name: "shared_field_option_sets",
    column_name,
    is_nullable: "YES",
    column_default: null,
  })),
  {
    table_name: "custom_field_definitions",
    column_name: "shared_option_set_id",
    is_nullable: "YES",
    column_default: null,
  },
];

function fakeClient(options: {
  columns?: ColumnRow[];
  indexes?: { name: string; valid: boolean }[];
}) {
  const columns = options.columns ?? HEALTHY_COLUMNS;
  const indexes =
    options.indexes ?? SHARED_FIELD_OPTION_SET_INDEXES.map((name) => ({ name, valid: true }));
  return {
    query: async (sql: string) =>
      /information_schema\.columns/i.test(sql) ? { rows: columns } : { rows: indexes },
  } as unknown as PoolClient;
}

describe("assertSharedFieldOptionSetsMigration", () => {
  it("passes on a complete, valid catalog", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(fakeClient({}), "compass_dev")
    ).resolves.toBeUndefined();
  });

  it("fails when the new table is missing a column", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.filter((column) => column.column_name !== "options"),
        }),
        "compass_dev"
      )
    ).rejects.toThrow(/shared_field_option_sets\.options/);
  });

  it("fails when custom_field_definitions never got the new column", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.filter(
            (column) => column.column_name !== "shared_option_set_id"
          ),
        }),
        "compass_dev"
      )
    ).rejects.toThrow(/custom_field_definitions\.shared_option_set_id/);
  });

  it("fails when the new column is NOT NULL — every existing row must stay opt-out", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.map((column) =>
            column.column_name === "shared_option_set_id"
              ? { ...column, is_nullable: "NO" }
              : column
          ),
        }),
        "compass_dev"
      )
    ).rejects.toThrow(/nullable with no default/);
  });

  it("fails when the new column carries a default", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.map((column) =>
            column.column_name === "shared_option_set_id"
              ? { ...column, column_default: "'set-1'::uuid" }
              : column
          ),
        }),
        "compass_dev"
      )
    ).rejects.toThrow(/nullable with no default/);
  });

  it("fails when an index is missing", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(
        fakeClient({ indexes: [{ name: SHARED_FIELD_OPTION_SET_INDEXES[0], valid: true }] }),
        "compass_dev"
      )
    ).rejects.toThrow(/idx_custom_field_definitions_shared_option_set/);
  });

  it("fails when an async index built but is not valid", async () => {
    await expect(
      assertSharedFieldOptionSetsMigration(
        fakeClient({
          indexes: SHARED_FIELD_OPTION_SET_INDEXES.map((name, i) => ({ name, valid: i === 0 })),
        }),
        "compass_dev"
      )
    ).rejects.toThrow(/not valid|missing/i);
  });
});

describe("migration 052 registration", () => {
  it("is registered in the runner manifest under its exact name", async () => {
    const { readFileSync } = await import("node:fs");
    const runner = readFileSync("lib/migrations/runner.ts", "utf8");
    expect(runner).toContain('name: "052_shared_field_option_sets"');
    // Async index DDL in this migration must be waited on before the receipt.
    expect(runner).toMatch(/ASYNC_WAIT_MIGRATIONS[\s\S]{0,400}052_shared_field_option_sets/);
  });

  it("ships additive DDL only — no drops, no backfill, no FK", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      "prisma/migrations/052_shared_field_option_sets/migration.sql",
      "utf8"
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS shared_field_option_sets/);
    expect(sql).toMatch(
      /ALTER TABLE custom_field_definitions ADD COLUMN IF NOT EXISTS shared_option_set_id UUID;/
    );
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    // DSQL only supports ASYNC index builds.
    for (const statement of sql.split(";")) {
      if (/CREATE\s+(UNIQUE\s+)?INDEX/i.test(statement)) {
        expect(statement).toMatch(/INDEX ASYNC/i);
      }
    }
  });
});
