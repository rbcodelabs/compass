import type { PoolClient } from "pg"

const indexes = ["idx_experiment_study_links_pair", "idx_experiment_study_links_workspace", "idx_experiment_study_links_study"]

export async function assertExperimentResearchStudyLinksMigration(client: PoolClient, schema: string) {
  const columns = await client.query<{ column_name: string; is_nullable: string }>(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'experiment_research_study_links'", [schema],
  )
  const required = ["id", "workspace_id", "experiment_id", "study_id", "created_at", "source"]
  if (required.some(name => !columns.rows.some(column => column.column_name === name && column.is_nullable === "NO")) || !columns.rows.some(column => column.column_name === "created_by_id")) {
    throw new Error("Migration 060 postcondition failed: missing or nullable link columns")
  }
  const result = await client.query<{ name: string; valid: boolean; unique: boolean; definition: string }>(
    `SELECT i.relname AS name, ix.indisvalid AS valid, ix.indisunique AS unique, pg_get_indexdef(i.oid) AS definition
     FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname = 'experiment_research_study_links' AND i.relname = ANY($2::text[])`, [schema, indexes],
  )
  const expected = ["(experiment_id, study_id)", "(workspace_id)", "(study_id)"]
  if (indexes.some((name, index) => !result.rows.some(row => row.name === name && row.valid && (index !== 0 || row.unique) && row.definition.includes(expected[index])))) {
    throw new Error("Migration 060 postcondition failed: link indexes missing, invalid, or incorrect")
  }
}
