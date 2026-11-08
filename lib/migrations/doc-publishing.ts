import type { PoolClient } from "pg"

export const DOC_PUBLISHING_MIGRATION = "113_doc_publishing"

/** Columns 113 must leave on docs. Both nullable by design: NULL = private, every existing row's state. */
const EXPECTED_COLUMNS: { column: string; dataType: string }[] = [
  { column: "published_at", dataType: "timestamp without time zone" },
  { column: "published_by_id", dataType: "uuid" },
]

/**
 * Postcondition run before 113's completion receipt. A missing, mistyped or NOT NULL column would make the
 * publish code fail (or, worse, leave docs unreadable) on rows written before it existed, so the attempt stays
 * unfinished and the next POST retries. Existing rows are not inspected: the migration changes no data.
 */
export async function assertDocPublishingMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'docs' AND column_name = ANY($2)",
    [schema, EXPECTED_COLUMNS.map((entry) => entry.column)],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType } of EXPECTED_COLUMNS) {
    const row = actual.get(column)
    if (!row) throw new Error(`${DOC_PUBLISHING_MIGRATION}: column postcondition failed: docs.${column} missing`)
    if (row.data_type !== dataType) {
      throw new Error(`${DOC_PUBLISHING_MIGRATION}: type postcondition failed: docs.${column} is ${row.data_type}, expected ${dataType}`)
    }
    if (row.is_nullable !== "YES") {
      throw new Error(`${DOC_PUBLISHING_MIGRATION}: nullability postcondition failed: docs.${column} is NOT NULL`)
    }
  }
}
