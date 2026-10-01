/**
 * Postconditions for 069_background_agent_runs.
 *
 * Two of these indexes are load-bearing correctness, not performance:
 * `idx_agent_runs_worker_token` is the callback authentication lookup, and
 * `idx_agent_run_events_run_seq` is what makes a retried event batch idempotent.
 * A run started against a schema where either index is merely *ready* but not
 * unique would accept duplicate events silently, so uniqueness is asserted
 * explicitly rather than inferred from the DDL having executed.
 */

import type { PoolClient } from "pg"

export const AGENT_RUN_TABLES = ["agent_runs", "agent_run_events"]
export const AGENT_RUN_UNIQUE_INDEXES = ["idx_agent_runs_worker_token", "idx_agent_run_events_run_seq"]
export const AGENT_RUN_INDEXES = [
  ...AGENT_RUN_UNIQUE_INDEXES,
  "idx_agent_runs_conversation_created",
  "idx_agent_runs_status_heartbeat",
  "idx_agent_runs_workspace_user",
  "idx_agent_run_events_run_created",
]

export async function assertBackgroundAgentRunsMigration(client: PoolClient, schema: string) {
  const expectedColumns = [
    { name: "agent_runs.id", nullable: false },
    { name: "agent_runs.conversation_id", nullable: false },
    { name: "agent_runs.workspace_id", nullable: false },
    { name: "agent_runs.user_id", nullable: false },
    { name: "agent_runs.status", nullable: false },
    { name: "agent_runs.kind", nullable: false },
    { name: "agent_runs.worker_token_hash", nullable: false },
    { name: "agent_runs.api_key_id", nullable: true },
    { name: "agent_runs.sandbox_name", nullable: true },
    { name: "agent_runs.sandbox_stopped_at", nullable: true },
    { name: "agent_runs.claim_id", nullable: true },
    { name: "agent_runs.deadline_at", nullable: false },
    { name: "agent_runs.last_heartbeat_at", nullable: true },
    { name: "agent_runs.status_changed_at", nullable: false },
    { name: "agent_runs.started_at", nullable: true },
    { name: "agent_runs.finished_at", nullable: true },
    { name: "agent_runs.last_seq", nullable: false },
    { name: "agent_runs.event_count", nullable: false },
    { name: "agent_runs.payload_bytes", nullable: false },
    { name: "agent_runs.model", nullable: true },
    { name: "agent_runs.input_tokens", nullable: true },
    { name: "agent_runs.output_tokens", nullable: true },
    { name: "agent_runs.num_turns", nullable: true },
    { name: "agent_runs.cost_usd", nullable: true },
    { name: "agent_runs.duration_ms", nullable: true },
    { name: "agent_runs.pack_provenance", nullable: true },
    { name: "agent_runs.error", nullable: true },
    { name: "agent_runs.error_code", nullable: true },
    { name: "agent_runs.created_at", nullable: false },
    { name: "agent_runs.updated_at", nullable: false },
    { name: "agent_run_events.id", nullable: false },
    { name: "agent_run_events.run_id", nullable: false },
    { name: "agent_run_events.seq", nullable: false },
    { name: "agent_run_events.type", nullable: false },
    { name: "agent_run_events.payload_json", nullable: false },
    { name: "agent_run_events.created_at", nullable: false },
  ]
  const tables = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, AGENT_RUN_TABLES]
  )
  if (AGENT_RUN_TABLES.some(name => !tables.rows.some(row => row.table_name === name)))
    throw new Error("069_background_agent_runs: missing tables")
  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])",
    [schema, AGENT_RUN_TABLES]
  )
  for (const expected of expectedColumns) {
    const actual = columns.rows.find(row => `${row.table_name}.${row.column_name}` === expected.name)
    if (!actual || (actual.is_nullable === "YES") !== expected.nullable)
      throw new Error(`069_background_agent_runs: column postcondition failed: ${expected.name}`)
  }
  const indexes = await client.query<{ name: string; valid: boolean; ready: boolean; unique: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`,
    [schema, AGENT_RUN_INDEXES]
  )
  for (const name of AGENT_RUN_INDEXES) {
    const index = indexes.rows.find(row => row.name === name)
    if (!index || !index.valid || !index.ready)
      throw new Error(`069_background_agent_runs: index ${name} is missing or unfinished`)
  }
  for (const name of AGENT_RUN_UNIQUE_INDEXES) {
    if (!indexes.rows.find(row => row.name === name)?.unique)
      throw new Error(`069_background_agent_runs: index ${name} is not unique; callback idempotency would not hold`)
  }
}
