import type { PoolClient } from "pg"

export const DECISION_VOTES_MIGRATION = "127_decision_votes"
export const DECISION_VOTES_TABLE = "decision_votes"

/** Writable columns declared by migration 127. */
const EXPECTED_COLUMNS: { column: string; nullable: boolean }[] = [
  { column: "id", nullable: false },
  { column: "workspace_id", nullable: false },
  { column: "request_id", nullable: false },
  { column: "revision_id", nullable: false },
  { column: "question_index", nullable: false },
  { column: "chosen_option", nullable: false },
  { column: "voter_user_id", nullable: false },
  { column: "created_at", nullable: false },
  { column: "updated_at", nullable: false },
]

export const DECISION_VOTES_INDEXES = [
  // One vote per person per question per revision: the upsert key, and what stops two tabs double-voting.
  { name: "idx_decision_votes_voter", columns: "request_id,revision_id,question_index,voter_user_id", unique: true },
] as const

/**
 * Postcondition run before the migration's completion receipt is written. The unique index is what
 * keeps a person to one vote per question, so an async build that never finished (or a
 * drifted table) fails closed instead of letting concurrent votes be counted twice.
 */
export async function assertDecisionVotesMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string; data_type: string; character_maximum_length: number | null; is_generated: string; column_default: string | null; datetime_precision: number | null }>(
    "SELECT column_name, is_nullable, data_type, character_maximum_length, is_generated, column_default, datetime_precision FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
    [schema, DECISION_VOTES_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, nullable } of EXPECTED_COLUMNS) {
    const row = actual.get(column)
    const type = column === "chosen_option" ? "character varying" : column === "question_index" ? "integer" : column.endsWith("_at") ? "timestamp without time zone" : "uuid"
    const defaultMatches = column === "id" ? /^(?:[a-z_]+\.)?gen_random_uuid\(\)$/.test(row?.column_default ?? "")
      : column.endsWith("_at") ? /^(?:CURRENT_TIMESTAMP|now\(\))$/i.test(row?.column_default ?? "")
      : row?.column_default === null
    if (!row || !defaultMatches || row.datetime_precision !== (column.endsWith("_at") ? 3 : null) || (row.is_nullable === "YES") !== nullable || row.data_type !== type || row.is_generated !== "NEVER" || (column === "chosen_option" && row.character_maximum_length !== 120)) {
      throw new Error(`migration 127 postcondition failed: ${DECISION_VOTES_TABLE}.${column} is missing or has the wrong shape`)
    }
  }

  if (result.rows.length !== EXPECTED_COLUMNS.length) {
    throw new Error("127_decision_votes: unexpected columns")
  }

  const primaryKey = await client.query<{ columns: string[]; valid: boolean; ready: boolean }>(
    `SELECT i.indisvalid AS valid, i.indisready AS ready,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                  WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
       FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'decision_votes' AND i.indisprimary`,
    [schema],
  )
  if (primaryKey.rows.length !== 1 || !primaryKey.rows[0].valid || !primaryKey.rows[0].ready || primaryKey.rows[0].columns.join(",") !== "id") {
    throw new Error("127_decision_votes: primary key postcondition failed")
  }

  for (const expected of DECISION_VOTES_INDEXES) {
    const index = await client.query<{
      valid: boolean
      ready: boolean
      unique: boolean
      table_name: string
      columns: string[]
      predicate: string | null
      expression: string | null
    }>(
      `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_expr(i.indexprs,i.indrelid) AS expression
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
      [schema, expected.name],
    )
    const row = index.rows[0]
    if (
      index.rows.length !== 1 ||
      !row.valid ||
      !row.ready ||
      row.unique !== expected.unique ||
      row.table_name !== DECISION_VOTES_TABLE ||
      row.columns.join(",") !== expected.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`migration 127 postcondition failed: index ${expected.name} is missing, not ready, or has drifted`)
    }
  }
}
