import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ManagedPilotContext } from "./managed-context";
import { applyMigrations, getMigrationStatus, partitionPendingMigrations, assertManagedMigrationManifest } from "@/lib/migrations/runner";

type Owner = { deployment_id: string; commit_sha: string; run_id: string; workspace_id: string; claimed_by: string | null; claim_script: string | null };
function table(context: ManagedPilotContext) {
  if (!/^compass_pr_276_[a-f0-9]{12}$/.test(context.schema) || context.schema !== `compass_pr_276_${context.sha.slice(0, 12)}`) throw new Error("Invalid managed schema");
  return `"${context.schema}"._managed_pilot_owner`;
}
async function requireOwner(client: PoolClient, context: ManagedPilotContext): Promise<Owner> {
  const { rows } = await client.query<Owner>(`SELECT deployment_id, commit_sha, run_id, workspace_id, claimed_by, claim_script FROM ${table(context)} WHERE id=1`);
  const owner = rows[0];
  if (rows.length !== 1 || owner.deployment_id !== context.deploymentId || owner.commit_sha !== context.sha || owner.run_id !== context.runId || owner.workspace_id !== context.workspaceId) throw new Error("Managed schema ownership mismatch");
  return owner;
}

export async function initializeManagedPilot(pool: Pool, context: ManagedPilotContext): Promise<Response> {
  const ownerTable = table(context);
  assertManagedMigrationManifest(context.schema);
  const client = await pool.connect();
  try {
    const exists = await client.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1", [context.schema]);
    if (exists.rows.length) {
      await requireOwner(client, context);
      return Response.json({ schema: context.schema, initialized: true, reused: true });
    }
    // CREATE without IF NOT EXISTS is the admission fence. A crash between DDL
    // and ownership deliberately leaves an unowned schema, never auto-adopted.
    await client.query(`CREATE SCHEMA "${context.schema}"`);
    await client.query(`CREATE TABLE ${ownerTable} (
      id INTEGER PRIMARY KEY, deployment_id TEXT NOT NULL, commit_sha TEXT NOT NULL,
      run_id UUID NOT NULL, workspace_id UUID NOT NULL, claimed_by UUID,
      claim_script TEXT, claimed_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await client.query(`INSERT INTO ${ownerTable} (id, deployment_id, commit_sha, run_id, workspace_id) VALUES (1,$1,$2,$3,$4)`,
      [context.deploymentId, context.sha, context.runId, context.workspaceId]);
    return Response.json({ schema: context.schema, initialized: true, reused: false });
  } finally { client.release(); }
}

/** Expected index names after the actually finished, applicable SQL manifest. */
export function expectedManagedIndexes(schema: string, applied: readonly string[]) {
  const expected = new Set<string>();
  for (const migration of partitionPendingMigrations(schema, new Set()).pending) {
    if (!applied.includes(migration.name)) continue;
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations", migration.name, "migration.sql"), "utf8").replace(/--[^\n]*/g, "");
    const pattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:ASYNC\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?|DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?/gi;
    for (const match of sql.matchAll(pattern)) {
      if (match[1]) expected.add(match[1]); else expected.delete(match[2]);
    }
  }
  return [...expected];
}

export async function getManagedMigrationStatus(pool: Pool, context: ManagedPilotContext): Promise<Response> {
  assertManagedMigrationManifest(context.schema);
  const client = await pool.connect();
  try {
    const owner = await requireOwner(client, context);
    const response = await getMigrationStatus(pool, context.schema);
    if (!response.ok) throw new Error("Migration status unavailable");
    const status = await response.json();
    const expected = expectedManagedIndexes(context.schema, status.appliedMigrations);
    const { rows } = await client.query<{ name: string; valid: boolean }>(`SELECT c.relname AS name, i.indisvalid AND i.indisready AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1`, [context.schema]);
    const missingOrInvalidIndexes = expected.filter(name => !rows.some(row => row.name === name && row.valid));
    const invalidIndexes = rows.filter(row => !row.valid).map(row => row.name);
    const ready = !owner.claimed_by && status.pending.length === 0 && status.unresolvedMigrations.length === 0 &&
      status.geodeDocumentStorage?.ready === true && missingOrInvalidIndexes.length === 0 && invalidIndexes.length === 0;
    return Response.json({ ...status, managed: { owner, missingOrInvalidIndexes, invalidIndexes, ready } });
  } finally { client.release(); }
}

export async function assertManagedPilotReady(pool: Pool, context: ManagedPilotContext): Promise<void> {
  const response = await getManagedMigrationStatus(pool, context);
  const status = await response.json();
  if (!status.managed.ready) throw new Error("Managed pilot migrations are not ready");
}

export async function applyManagedMigration(pool: Pool, context: ManagedPilotContext, script: string): Promise<Response> {
  assertManagedMigrationManifest(context.schema);
  if (!partitionPendingMigrations(context.schema, new Set()).pending.some(entry => entry.name === script)) throw new Error("Explicit registered applicable migration required");
  const client = await pool.connect();
  const claim = randomUUID();
  try {
    await requireOwner(client, context);
    const applied = await client.query<{ migration_name: string }>(`SELECT migration_name FROM "${context.schema}"._prisma_migrations WHERE finished_at IS NOT NULL`).catch((error: { code?: string }) => {
      // Only a genuinely absent tracker on the newly owned schema is empty.
      if (error.code !== "42P01") throw error;
      return { rows: [] };
    });
    const first = partitionPendingMigrations(context.schema, new Set(applied.rows.map(row => row.migration_name))).pending[0];
    if (first?.name !== script) throw new Error("Only the first pending migration may be advanced");
    // No expiring lease: a killed request retains its claim. Status inspection
    // and an explicitly reviewed recovery are required; time alone grants nothing.
    const acquired = await client.query(`UPDATE ${table(context)} SET claimed_by=$1, claim_script=$2, claimed_at=CURRENT_TIMESTAMP WHERE id=1 AND claimed_by IS NULL RETURNING claimed_by`, [claim, script]);
    if (acquired.rowCount !== 1) throw new Error("Managed migration claim is active or requires inspected recovery");
    const result = await applyMigrations(pool, context.schema, script, { preProvisionedSchema: true, managedPilot: true });
    // A handled 202 is durable decision-runner progress, not a completed
    // migration. Permit the next explicit, status-checked continuation only.
    if (result.ok) await client.query(`UPDATE ${table(context)} SET claimed_by=NULL, claim_script=NULL, claimed_at=NULL WHERE id=1 AND claimed_by=$1`, [claim]);
    return result;
  } finally { client.release(); }
}

/**
 * Reviewed recovery for a claim a failed or killed request retained. Only the
 * exact claim id on the current first pending migration is released, and only
 * once it is older than any request could run (route maxDuration is 300s), so a
 * still-running request can never lose its claim. The runner decides on the
 * next explicit POST whether partial work is admissible.
 */
export async function releaseManagedClaim(pool: Pool, context: ManagedPilotContext, claim: string, script: string): Promise<Response> {
  assertManagedMigrationManifest(context.schema);
  const client = await pool.connect();
  try {
    const owner = await requireOwner(client, context);
    if (!owner.claimed_by || owner.claimed_by !== claim || owner.claim_script !== script) throw new Error("Managed claim does not match the requested claim");
    const applied = await client.query<{ migration_name: string }>(`SELECT migration_name FROM "${context.schema}"._prisma_migrations WHERE finished_at IS NOT NULL`);
    const first = partitionPendingMigrations(context.schema, new Set(applied.rows.map(row => row.migration_name))).pending[0];
    if (first?.name !== script) throw new Error("Only a claim on the first pending migration may be released");
    const released = await client.query(`UPDATE ${table(context)} SET claimed_by=NULL, claim_script=NULL, claimed_at=NULL WHERE id=1 AND claimed_by=$1 AND claim_script=$2 AND claimed_at < CURRENT_TIMESTAMP - INTERVAL '6 minutes'`, [claim, script]);
    if (released.rowCount !== 1) throw new Error("Managed claim not released: it is too recent or changed");
    return Response.json({ schema: context.schema, released: true, claim, script });
  } finally { client.release(); }
}
