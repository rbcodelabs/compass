/** Disposable local PostgreSQL proof; never a hosted migration entrypoint. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { initializeManagedPilot, applyManagedMigration, getManagedMigrationStatus } from "../lib/preview-automation/managed-migrations";
import { withE2ERunLock } from "./e2e-run-lock.mjs";

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert(process.env.E2E_ISOLATED_DATABASE === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/compass_e2e", "Disposable local database only");
  assert(!process.env.VERCEL_ENV && process.env.NODE_ENV !== "production", "Hosted execution refused");
  await withE2ERunLock(process.env, async () => {
    const sha = randomUUID().replaceAll("-", "") + "01234567";
    const context = { schema: `compass_pr_276_${sha.slice(0, 12)}`, pr: "276", sha, deploymentId: "dpl_LocalProof", origin: "https://local-proof.vercel.app", runId: randomUUID(), workspaceId: randomUUID() };
    const sentinels = [`sentinel_${sha.slice(0, 12)}_prod`, `sentinel_${sha.slice(0, 12)}_preview`];
    const created: string[] = [];
    const pool = new Pool({ connectionString: url.toString(), max: 6 });
    try {
      for (const schema of sentinels) {
        await pool.query(`CREATE SCHEMA "${schema}"`); created.push(schema);
        await pool.query(`CREATE TABLE "${schema}".docs (id INTEGER PRIMARY KEY, content TEXT NOT NULL)`);
        await pool.query(`INSERT INTO "${schema}".docs VALUES (1, 'untouched synthetic sentinel')`);
        for (const table of ["oauth_tokens", "oauth_consents", "oauth_authorization_codes"]) {
          await pool.query(`CREATE TABLE "${schema}".${table} (id INTEGER PRIMARY KEY, revoked_at TIMESTAMP, content TEXT NOT NULL)`);
          await pool.query(`INSERT INTO "${schema}".${table} VALUES (1, NULL, 'untouched synthetic OAuth sentinel')`);
        }
      }
      async function snapshot() {
        return {
          columns: (await pool.query("SELECT table_schema,table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=ANY($1::text[]) ORDER BY table_schema,table_name,ordinal_position", [sentinels])).rows,
          data: await Promise.all(sentinels.flatMap(s => ["docs", "oauth_tokens", "oauth_consents", "oauth_authorization_codes"].map(async table => (await pool.query(`SELECT * FROM "${s}".${table} ORDER BY id`)).rows))),
          // No public data is read: catalog shape detects accidental global DDL.
          publicColumns: (await pool.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
          publicIndexes: (await pool.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows,
          publicRelations: (await pool.query("SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname")).rows,
        };
      }
      const before = await snapshot();
      await initializeManagedPilot(pool, context); created.push(context.schema);
      await assert.rejects(initializeManagedPilot(pool, { ...context, deploymentId: "dpl_Wrong" }), /ownership/);
      let iterations = 0;
      for (; iterations < 500; iterations++) {
        const status = await (await getManagedMigrationStatus(pool, context)).json();
        assert(!status.managed.owner.claimed_by, "Uncertain claim needs inspection");
        if (status.managed.ready) break;
        assert(status.pending[0], JSON.stringify(status.managed));
        const response = await applyManagedMigration(pool, context, status.pending[0]);
        const result = await response.json();
        assert(response.ok, `${status.pending[0]} ${response.status}: ${JSON.stringify(result)}`);
        assert.deepEqual(await snapshot(), before, "Non-pilot sentinel catalog/data changed");
      }
      assert(iterations < 500, "Migration continuation exceeded bounded proof");
      const status = await (await getManagedMigrationStatus(pool, context)).json();
      assert.equal(status.managed.ready, true);
      assert.deepEqual(status.pending, []);
      assert.deepEqual(status.managed.missingOrInvalidIndexes, []);
      assert.deepEqual(await snapshot(), before);
      console.log(JSON.stringify({ proof: "managed-full-manifest", applied: status.appliedMigrations.length, iterations, sentinels: "unchanged", readiness: true }));
    } finally {
      // Only random schemas created by this invocation on the proven local DB.
      for (const schema of created.reverse()) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
    return 0;
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
