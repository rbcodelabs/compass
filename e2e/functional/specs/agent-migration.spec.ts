import { randomUUID } from "node:crypto";
import pg from "pg";
import { test, expect } from "../fixtures/index";
import { assertIsolatedE2EDatabase, isolatedE2EConnectionString } from "../fixtures/isolated-database";
import { applyMigrations } from "../../../lib/migrations/runner";
import { assertAgentIdentityMigration } from "../../../lib/migrations/agent-identity";

test("registered agent migration applies twice safely and preserves existing assignments", async () => {
  await assertIsolatedE2EDatabase();
  const pool = new pg.Pool({ connectionString: isolatedE2EConnectionString() });
  const schema = `agent_migration_${randomUUID().replaceAll("-", "")}`;
  const taskId = randomUUID();
  const userId = randomUUID();
  try {
    // A throwaway schema in the explicitly guarded compass_e2e database keeps
    // migration receipts and deliberately minimal legacy tables isolated.
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE "${schema}".api_keys (id UUID PRIMARY KEY)`);
    await pool.query(`CREATE TABLE "${schema}".tasks (id UUID PRIMARY KEY, assignee_user_id UUID)`);
    await pool.query(`INSERT INTO "${schema}".tasks VALUES ($1, $2)`, [taskId, userId]);
    const first = await applyMigrations(pool, schema, "049_agent_identity", { preProvisionedSchema: true });
    expect(first.status, JSON.stringify(await first.json())).toBe(200);
    const second = await applyMigrations(pool, schema, "049_agent_identity", { preProvisionedSchema: true });
    expect(second.status, JSON.stringify(await second.json())).toBe(200);
    const client = await pool.connect();
    try { await assertAgentIdentityMigration(client, schema); } finally { client.release(); }
    const receipt = await pool.query(`SELECT COUNT(*)::integer AS count FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, ["049_agent_identity"]);
    expect(receipt.rows[0].count).toBe(1);
    const task = await pool.query(`SELECT assignee_user_id, assignee_agent_id FROM "${schema}".tasks WHERE id=$1`, [taskId]);
    expect(task.rows[0]).toEqual({ assignee_user_id: userId, assignee_agent_id: null });
  } finally {
    // The identifier is generated here and cannot refer to a user schema.
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});
