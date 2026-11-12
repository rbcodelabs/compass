/**
 * Which of the legacy link relations still exist in a schema. Migration 116 drops them (lib/migrations/entity-links-legacy-drop.ts), so
 * every older hook and every status block that READS one must ask first: once 116 has run, a missing relation means "dropped, nothing to
 * carry over", never an error. Catalog reads only (information_schema), safe on Aurora DSQL and plain Postgres.
 */
import type { PoolClient } from "pg"

export const LEGACY_LINK_TABLES = ["task_links", "artifact_links", "opportunity_objective_links", "solution_key_result_links"] as const
export type LegacyLinkTable = (typeof LEGACY_LINK_TABLES)[number]

/** The pointer column 116 drops from `opportunities`. */
export const LEGACY_POINTER_COLUMN = "linked_key_result_id"
export const LEGACY_POINTER_RELATION = "opportunities.linked_key_result_id" as const
export type LegacyRelation = LegacyLinkTable | typeof LEGACY_POINTER_RELATION

export const ALL_LEGACY_RELATIONS: readonly LegacyRelation[] = [...LEGACY_LINK_TABLES, LEGACY_POINTER_RELATION]

/** The set of legacy relations that exist in `schema` right now. */
export async function presentLegacyRelations(client: PoolClient, schema: string): Promise<Set<LegacyRelation>> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [schema, [...LEGACY_LINK_TABLES]],
  )
  const column = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'opportunities' AND column_name = $2`,
    [schema, LEGACY_POINTER_COLUMN],
  )
  const present = new Set<LegacyRelation>(tables.rows.map((row) => row.table_name as LegacyLinkTable))
  if (Number(column.rows[0]?.n ?? "0") > 0) present.add(LEGACY_POINTER_RELATION)
  return present
}

/** The legacy source each status block reads, by name, so callers need not spell the table names. */
export const LEGACY_STATUS_SOURCES = {
  opportunity: ["opportunity_objective_links", LEGACY_POINTER_RELATION],
  artifact: ["artifact_links"],
  task: ["task_links"],
  solutionKeyResult: ["solution_key_result_links"],
  typedLinks: ["opportunity_objective_links", "solution_key_result_links", LEGACY_POINTER_RELATION],
} as const satisfies Record<string, readonly LegacyRelation[]>

/** The relations of `needs` that no longer exist (empty = the whole legacy source is still there). */
export async function missingLegacyRelations(client: PoolClient, schema: string, needs: readonly LegacyRelation[]): Promise<LegacyRelation[]> {
  const present = await presentLegacyRelations(client, schema)
  return needs.filter((relation) => !present.has(relation))
}

/**
 * The legacy relations each OLDER data hook reads. A hook whose source is gone is skipped with a log line: 116 only drops a table after
 * proving every live row is in entity_links, so there is nothing left for the hook to carry over.
 */
export const LEGACY_SOURCES_BY_MIGRATION: Readonly<Record<string, readonly LegacyRelation[]>> = {
  "071_typed_link_tables": ["opportunity_objective_links", LEGACY_POINTER_RELATION],
  "072_typed_links_residual_backfill": ["opportunity_objective_links", LEGACY_POINTER_RELATION],
  "095_entity_links_backfill_opportunity": ["opportunity_objective_links", LEGACY_POINTER_RELATION],
  "106_entity_links_residual_opportunity": ["opportunity_objective_links", LEGACY_POINTER_RELATION],
  "096_entity_links_backfill_artifact": ["artifact_links"],
  "097_entity_links_backfill_task": ["task_links"],
  "098_entity_links_backfill_solution_key_result": ["solution_key_result_links"],
  "113_entity_links_backfill_conversation": ["task_links"],
  "115_entity_links_task_link_move": ["task_links"],
}
