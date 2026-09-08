import type { PoolClient } from "pg"

const indexes = ["agents_owner_user_id_idx", "agent_workspace_grants_agent_id_workspace_id_key", "agent_workspace_grants_workspace_id_idx", "api_keys_agent_id_idx", "tasks_assignee_agent_id_idx", "agent_tool_calls_agent_id_created_at_idx", "agent_tool_calls_workspace_id_created_at_idx"]

export async function assertAgentIdentityMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, ["agents", "agent_workspace_grants", "agent_tool_calls", "api_keys", "tasks"]],
  )
  const present = new Set(columns.rows.map(row => `${row.table_name}.${row.column_name}`))
  const required = ["agents.id", "agents.owner_user_id", "agents.status", "agent_workspace_grants.agent_id", "agent_workspace_grants.workspace_id", "agent_workspace_grants.access", "agent_workspace_grants.revoked_at", "agent_tool_calls.id", "agent_tool_calls.status", "api_keys.agent_id", "tasks.assignee_agent_id"]
  if (required.some(column => !present.has(column))) throw new Error("Agent identity migration is missing required columns.")
  const result = await client.query<{ name: string; valid: boolean }>(
    "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])", [schema, indexes],
  )
  if (indexes.some(name => !result.rows.some(row => row.name === name && row.valid))) throw new Error("Agent identity migration indexes are missing or not valid.")
}
