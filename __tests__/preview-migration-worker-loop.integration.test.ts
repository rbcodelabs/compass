/**
 * The scoped preview worker (scripts/preview-automation/migrate.ts) provisions a FRESH schema by calling
 * applyMigrations with no target in a loop until `previewMigrationsReady`. 069 is explicit-only for production-style
 * callers, so the worker must opt in (`includeExplicitOnly`), otherwise it burns all 180 attempts on
 * pending: ["069_..."] and provisioning fails for every PR.
 *
 * Runs the real runner and the worker's real loop and readiness gate against throwaway schemas in local compass_e2e.
 * The full 001..067 chain cannot be replayed on local PostgreSQL (042 refuses the partial-039 catalog shape, a DSQL
 * artifact), so each schema gets the real 001_init tables and a finished receipt for every other migration ahead of
 * 068. What is under test is exactly the tail that changed: 068 and 069 through the loop and the readiness gate.
 *   WORKSPACE_ID_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/preview-migration-worker-loop.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner";
import { migrateToReady, previewMigrationsReady } from "../scripts/preview-automation/database";

const databaseUrl = process.env.WORKSPACE_ID_TEST_DATABASE_URL;
const RESIDUAL = "069_workspace_id_residual_backfill";

describe.skipIf(!databaseUrl)("preview worker migration loop on a fresh schema", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const previous = process.env.DATABASE_URL;
  const schemas: string[] = [];
  const noPause = async () => {};

  async function freshSchema() {
    const schema = `pvw_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    const init = await applyMigrations(pool, schema, "001_init", { preProvisionedSchema: true });
    expect(init.status).toBe(200);
    const { manifest } = await statusOf(schema);
    for (const name of manifest) {
      if (name === "001_init" || name === "068_workspace_id_on_solution_objective" || name === RESIDUAL) continue;
      await pool.query(`INSERT INTO "${schema}"._prisma_migrations (id, migration_name, finished_at) VALUES (gen_random_uuid(), $1, CURRENT_TIMESTAMP)`, [name]);
    }
    return schema;
  }
  const statusOf = async (schema: string) => (await (await getMigrationStatus(pool, schema)).json()) as { pending: string[]; appliedMigrations: string[]; unresolvedMigrations: string[]; manifest: string[]; notApplicable: unknown[] };
  const ready = (schema: string) => async () => {
    const status = await statusOf(schema);
    const indexes = await pool.query("SELECT COUNT(*) AS pending FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND (NOT i.indisvalid OR NOT i.indisready)", [schema]);
    return previewMigrationsReady(status, Number(indexes.rows[0].pending));
  };

  beforeAll(() => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database");
    process.env.DATABASE_URL = databaseUrl;
  });
  afterAll(async () => {
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("the worker's loop (includeExplicitOnly) reaches previewMigrationsReady and applies 069 right after 068", async () => {
    const schema = await freshSchema();
    await expect(
      migrateToReady(async () => (await applyMigrations(pool, schema, undefined, { preProvisionedSchema: true, includeExplicitOnly: true })).status, ready(schema), noPause, 40),
    ).resolves.toBeUndefined();
    const status = await statusOf(schema);
    expect(status.pending).toEqual([]);
    expect(status.appliedMigrations).toEqual(expect.arrayContaining(["068_workspace_id_on_solution_objective", RESIDUAL]));
    expect(status.appliedMigrations.indexOf(RESIDUAL)).toBeGreaterThan(status.appliedMigrations.indexOf("068_workspace_id_on_solution_objective"));
  }, 120_000);

  it("a production-style untargeted loop never applies 069: it is left pending, and the response says so instead of 'up to date'", async () => {
    const schema = await freshSchema();
    // Drive everything else to completion without the opt-in.
    for (let i = 0; i < 40; i += 1) {
      const response = await applyMigrations(pool, schema, undefined, { preProvisionedSchema: true });
      expect(response.status).toBe(200);
      if ((await statusOf(schema)).pending.join() === RESIDUAL) break;
    }
    const status = await statusOf(schema);
    expect(status.pending).toEqual([RESIDUAL]);
    expect(status.appliedMigrations).toContain("068_workspace_id_on_solution_objective");
    expect(status.appliedMigrations).not.toContain(RESIDUAL);

    const again = await applyMigrations(pool, schema, undefined, { preProvisionedSchema: true });
    const body = (await again.json()) as { message: string; skippedExplicitOnly?: string[] };
    expect(body.message).not.toMatch(/All migrations up to date/);
    expect(body.message).toMatch(/explicit-only, still pending/);
    expect(body.message).toContain(RESIDUAL);
    expect(body.skippedExplicitOnly).toEqual([RESIDUAL]);

    // ...and this is exactly why the worker must opt in: without it, the readiness gate can never be satisfied.
    await expect(
      migrateToReady(async () => (await applyMigrations(pool, schema, undefined, { preProvisionedSchema: true })).status, ready(schema), noPause, 4),
    ).rejects.toThrow(/did not become ready/);

    // An explicit POST still applies it.
    const explicit = await applyMigrations(pool, schema, RESIDUAL, { preProvisionedSchema: true });
    expect(explicit.status).toBe(200);
    expect((await statusOf(schema)).pending).toEqual([]);
  }, 120_000);
});
