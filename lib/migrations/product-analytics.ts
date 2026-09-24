import type { PoolClient } from "pg"

export const ANALYTICS_TABLES = ["analytics_connections", "metric_definitions", "metric_revisions", "metric_bindings", "metric_observations", "workspace_activation_states"]
export const ANALYTICS_INDEXES = ["idx_analytics_connection_workspace_provider", "idx_metric_definition_workspace", "idx_metric_revision_number", "idx_metric_revision_workspace", "idx_metric_binding_target", "idx_metric_binding_metric", "idx_metric_observation_refresh", "idx_metric_observation_binding"]

export async function assertProductAnalyticsMigration(client: PoolClient, schema: string) {
  const expectedColumns = [
    { name: "analytics_connections.id", nullable: false },
    { name: "analytics_connections.workspace_id", nullable: false },
    { name: "analytics_connections.provider", nullable: false },
    { name: "analytics_connections.project_id", nullable: false },
    { name: "analytics_connections.team_id", nullable: true },
    { name: "analytics_connections.secret_encrypted", nullable: true },
    { name: "analytics_connections.generation", nullable: false },
    { name: "analytics_connections.enabled", nullable: false },
    { name: "analytics_connections.health", nullable: false },
    { name: "analytics_connections.created_at", nullable: false },
    { name: "analytics_connections.updated_at", nullable: false },
    { name: "metric_definitions.id", nullable: false },
    { name: "metric_definitions.workspace_id", nullable: false },
    { name: "metric_definitions.current_revision_id", nullable: false },
    { name: "metric_definitions.revision", nullable: false },
    { name: "metric_definitions.archived", nullable: false },
    { name: "metric_definitions.created_at", nullable: false },
    { name: "metric_definitions.updated_at", nullable: false },
    { name: "metric_revisions.id", nullable: false },
    { name: "metric_revisions.workspace_id", nullable: false },
    { name: "metric_revisions.metric_id", nullable: false },
    { name: "metric_revisions.revision", nullable: false },
    { name: "metric_revisions.name", nullable: false },
    { name: "metric_revisions.unit", nullable: false },
    { name: "metric_revisions.provider", nullable: false },
    { name: "metric_revisions.connection_id", nullable: true },
    { name: "metric_revisions.query_json", nullable: false },
    { name: "metric_revisions.created_at", nullable: false },
    { name: "metric_bindings.id", nullable: false },
    { name: "metric_bindings.workspace_id", nullable: false },
    { name: "metric_bindings.metric_id", nullable: false },
    { name: "metric_bindings.revision_id", nullable: false },
    { name: "metric_bindings.target_type", nullable: false },
    { name: "metric_bindings.target_id", nullable: false },
    { name: "metric_bindings.baseline_json", nullable: false },
    { name: "metric_bindings.followup_json", nullable: false },
    { name: "metric_bindings.target_value", nullable: true },
    { name: "metric_bindings.active", nullable: false },
    { name: "metric_bindings.last_error", nullable: true },
    { name: "metric_bindings.last_attempt_at", nullable: true },
    { name: "metric_bindings.last_attempt_id", nullable: true },
    { name: "metric_bindings.created_at", nullable: false },
    { name: "metric_bindings.updated_at", nullable: false },
    { name: "metric_observations.id", nullable: false },
    { name: "metric_observations.workspace_id", nullable: false },
    { name: "metric_observations.binding_id", nullable: false },
    { name: "metric_observations.revision_id", nullable: false },
    { name: "metric_observations.refresh_key", nullable: false },
    { name: "metric_observations.window_kind", nullable: false },
    { name: "metric_observations.snapshot_json", nullable: false },
    { name: "metric_observations.data_json", nullable: false },
    { name: "metric_observations.retrieved_at", nullable: false },
    { name: "workspace_activation_states.workspace_id", nullable: false },
    { name: "workspace_activation_states.collection_started_at", nullable: false },
    { name: "workspace_activation_states.discovery_at", nullable: true },
    { name: "workspace_activation_states.delivery_at", nullable: true },
    { name: "workspace_activation_states.learning_at", nullable: true },
    { name: "workspace_activation_states.updated_at", nullable: false },
  ]
  const columns = await client.query<{ table_name: string; column_name: string; is_nullable: string }>("SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])", [schema, ANALYTICS_TABLES])
  for (const expected of expectedColumns) {
    const actual = columns.rows.find(row => `${row.table_name}.${row.column_name}` === expected.name)
    if (!actual || (actual.is_nullable === "YES") !== expected.nullable) throw new Error(`061_product_analytics: column postcondition failed: ${expected.name}`)
  }
  const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])", [schema, ANALYTICS_TABLES])
  if (ANALYTICS_TABLES.some(name => !tables.rows.some(row => row.table_name === name))) throw new Error("061_product_analytics: missing tables")
  const indexes = await client.query<{ name: string; valid: boolean; unique: boolean }>(`SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`, [schema, ANALYTICS_INDEXES])
  if (ANALYTICS_INDEXES.some(name => !indexes.rows.some(row => row.name === name && row.valid))) throw new Error("061_product_analytics: missing or unfinished indexes")
  for (const name of ["idx_analytics_connection_workspace_provider", "idx_metric_revision_number", "idx_metric_observation_refresh"]) {
    if (!indexes.rows.find(row => row.name === name)?.unique) throw new Error("061_product_analytics: missing uniqueness")
  }
}
