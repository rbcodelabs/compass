import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "@/lib/migrations/runner";

const databaseUrl = process.env.UPDATES_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("workspace Updates registered migration", () => {
  const schema = `updates_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const previous = process.env.DATABASE_URL;
  let created = false;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e"
    )
      throw new Error("Requires local compass_e2e");
    process.env.DATABASE_URL = databaseUrl;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
  });
  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
  it("creates the tables and unique indexes, reruns with one completed receipt", async () => {
    const first = await applyMigrations(pool, schema, "060_workspace_updates");
    const result = await first.json();
    expect(result, JSON.stringify(result)).not.toHaveProperty("error");
    expect(first.status).toBe(200);
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'workspace_update%' ORDER BY table_name",
      [schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "workspace_update_events",
      "workspace_updates_read_state",
      "workspace_updates_state",
    ]);
    const indexes = await pool.query(
      "SELECT c.relname,i.indisunique,i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [
        schema,
        [
          "workspace_update_events_revision_key",
          "workspace_updates_read_state_user_key",
        ],
      ],
    );
    expect(indexes.rows).toHaveLength(2);
    expect(indexes.rows.every((r) => r.indisunique && r.indisvalid)).toBe(true);
    const again = await applyMigrations(pool, schema, "060_workspace_updates");
    expect(again.status).toBe(200);
    const receipts = await pool.query(
      `SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name='060_workspace_updates' AND finished_at IS NOT NULL`,
    );
    expect(receipts.rows).toHaveLength(1);
  });
});
