import type { PoolClient } from "pg"

export const DOC_KIND_MIGRATION = "117_doc_kind"

/**
 * Postcondition run before 117's completion receipt. A missing, mistyped or NOT NULL column would make the Library and write_doc fail (or,
 * worse, refuse docs written before it existed), so the attempt stays unfinished and the next POST retries. Existing rows are not inspected:
 * the migration changes no data.
 */
export async function assertDocKindMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'docs' AND column_name = 'kind'",
    [schema],
  )
  const row = result.rows[0]
  if (!row) throw new Error(`${DOC_KIND_MIGRATION}: column postcondition failed: docs.kind missing`)
  if (row.data_type !== "character varying") {
    throw new Error(`${DOC_KIND_MIGRATION}: type postcondition failed: docs.kind is ${row.data_type}, expected character varying`)
  }
  if (row.is_nullable !== "YES") {
    throw new Error(`${DOC_KIND_MIGRATION}: nullability postcondition failed: docs.kind is NOT NULL`)
  }
}
