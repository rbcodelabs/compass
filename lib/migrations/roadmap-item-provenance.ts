import type { PoolClient } from "pg"

export const ROADMAP_ITEM_PROVENANCE_MIGRATION = "075_roadmap_item_provenance"

/** Columns 075 must leave on roadmap_items. Both are nullable by design: NULL is every existing row's state. */
const EXPECTED_COLUMNS: { column: string; dataType: string }[] = [
  { column: "auto_created", dataType: "boolean" },
  { column: "schedule_edited_at", dataType: "timestamp without time zone" },
]

/**
 * Postcondition run before 075's completion receipt. A column that is missing,
 * mistyped or NOT NULL would make the code that reads it fail on rows written
 * before it existed, so the attempt stays unfinished and the next POST retries.
 * Existing rows are deliberately not inspected: the migration changes no data.
 */
export async function assertRoadmapItemProvenanceMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'roadmap_items' AND column_name = ANY($2)",
    [schema, EXPECTED_COLUMNS.map((entry) => entry.column)],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType } of EXPECTED_COLUMNS) {
    const row = actual.get(column)
    if (!row) throw new Error(`${ROADMAP_ITEM_PROVENANCE_MIGRATION}: column postcondition failed: roadmap_items.${column} missing`)
    if (row.data_type !== dataType) {
      throw new Error(`${ROADMAP_ITEM_PROVENANCE_MIGRATION}: type postcondition failed: roadmap_items.${column} is ${row.data_type}, expected ${dataType}`)
    }
    if (row.is_nullable !== "YES") {
      throw new Error(`${ROADMAP_ITEM_PROVENANCE_MIGRATION}: nullability postcondition failed: roadmap_items.${column} is NOT NULL`)
    }
  }
}
