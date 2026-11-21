import type { PoolClient } from "pg"

export const EXTERNAL_LINKS_MIGRATION = "126_external_links"
export const EXTERNAL_LINKS_TABLE = "external_links"

type ExpectedColumn = { column: string; dataType: string; nullable: boolean; maxLength?: number; precision?: number; default?: "uuid" | "source" | "timestamp" }

const EXTERNAL_LINK_COLUMNS: readonly ExpectedColumn[] = [
  {"column":"id","default":"uuid","dataType":"uuid","nullable":false},
  {"column":"workspace_id","dataType":"uuid","nullable":false},
  {"column":"subject_type","maxLength":40,"dataType":"character varying","nullable":false},
  {"column":"subject_id","dataType":"uuid","nullable":false},
  {"column":"provider","maxLength":30,"dataType":"character varying","nullable":false},
  {"column":"url","maxLength":1000,"dataType":"character varying","nullable":false},
  {"column":"external_key","maxLength":1000,"dataType":"character varying","nullable":false},
  {"column":"external_key_hash","maxLength":64,"dataType":"character varying","nullable":false},
  {"column":"title","maxLength":255,"dataType":"character varying","nullable":false},
  {"column":"relation","maxLength":20,"dataType":"character varying","nullable":false},
  {"column":"status_snapshot","dataType":"text","nullable":true},
  {"column":"source","default":"source","maxLength":20,"dataType":"character varying","nullable":false},
  {"column":"created_by_id","dataType":"uuid","nullable":true},
  {"column":"created_at","precision":3,"default":"timestamp","dataType":"timestamp without time zone","nullable":false},
  {"column":"updated_at","precision":3,"default":"timestamp","dataType":"timestamp without time zone","nullable":false},
]

export const EXTERNAL_LINKS_INDEXES = [
  { table: EXTERNAL_LINKS_TABLE, name: "idx_external_links_subject_key", columns: "subject_type,subject_id,provider,external_key_hash", unique: true },
  { table: EXTERNAL_LINKS_TABLE, name: "idx_external_links_workspace_key", columns: "workspace_id,provider,external_key_hash", unique: false },
] as const

export async function assertExternalLinksMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string; character_maximum_length: number | null; datetime_precision: number | null; column_default: string | null; is_generated: string; is_identity: string }>(
    "SELECT column_name, data_type, is_nullable, character_maximum_length, datetime_precision, column_default, is_generated, is_identity FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
    [schema, EXTERNAL_LINKS_TABLE],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType, nullable, maxLength, precision, default: expectedDefault } of EXTERNAL_LINK_COLUMNS) {
    const row = actual.get(column)
    if (!row) {
      throw new Error(
        `${EXTERNAL_LINKS_MIGRATION}: column postcondition failed: ${EXTERNAL_LINKS_TABLE}.${column} missing`,
      )
    }
    if (row.is_generated !== "NEVER" || row.is_identity !== "NO") {
      throw new Error(`${EXTERNAL_LINKS_MIGRATION}: writability postcondition failed: ${EXTERNAL_LINKS_TABLE}.${column}`)
    }
    if (row.data_type !== dataType) {
      throw new Error(
        `${EXTERNAL_LINKS_MIGRATION}: type postcondition failed: ${EXTERNAL_LINKS_TABLE}.${column} is ${row.data_type}`,
      )
    }
    const defaultMatches = expectedDefault === "uuid" ? /^(?:[a-z_]+\.)?gen_random_uuid\(\)$/.test(row.column_default ?? "")
      : expectedDefault === "source" ? /^'UI'(?:::character varying)?$/.test(row.column_default ?? "")
      : expectedDefault === "timestamp" ? /^(?:CURRENT_TIMESTAMP|now\(\))$/i.test(row.column_default ?? "")
      : row.column_default === null
    if (row.character_maximum_length !== (maxLength ?? null) || row.datetime_precision !== (precision ?? null) || !defaultMatches) {
      throw new Error(`126_external_links: shape postcondition failed: external_links.${column}`)
    }
    if ((row.is_nullable === "YES") !== nullable) {
      throw new Error(
        `${EXTERNAL_LINKS_MIGRATION}: nullability postcondition failed: ${EXTERNAL_LINKS_TABLE}.${column} is_nullable=${row.is_nullable}`,
      )
    }
  }

  if (result.rows.length !== EXTERNAL_LINK_COLUMNS.length) {
    throw new Error(`${EXTERNAL_LINKS_MIGRATION}: unexpected columns in ${EXTERNAL_LINKS_TABLE}`)
  }

  // Compare key columns only. Aurora DSQL primary indexes also store non-key columns.
  const primaryKey = await client.query<{ columns: string[]; valid: boolean; ready: boolean }>(
    `SELECT i.indisvalid AS valid, i.indisready AS ready,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                  WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
       FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'external_links' AND i.indisprimary`,
    [schema],
  )
  if (primaryKey.rows.length !== 1 || !primaryKey.rows[0].valid || !primaryKey.rows[0].ready || primaryKey.rows[0].columns.join(",") !== "id") {
    throw new Error("126_external_links: primary key postcondition failed")
  }

  for (const idx of EXTERNAL_LINKS_INDEXES) {
    const indexResult = await client.query<{
      valid: boolean
      ready: boolean
      unique: boolean
      table_name: string
      columns: string[]
      predicate: string | null
      expression: string | null
    }>(
      `SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique,
              t.relname AS table_name,
              ARRAY(
                SELECT a.attname::text
                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
                WHERE k.ord <= i.indnkeyatts
                ORDER BY k.ord
              ) AS columns,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              pg_get_expr(i.indexprs, i.indrelid) AS expression
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, idx.name],
    )
    const row = indexResult.rows[0]
    const columns = Array.isArray(row?.columns) ? row.columns.join(",") : ""
    if (
      !row?.valid ||
      !row?.ready ||
      row.unique !== idx.unique ||
      row.table_name !== idx.table ||
      columns !== idx.columns ||
      row.predicate !== null ||
      row.expression !== null
    ) {
      throw new Error(`${EXTERNAL_LINKS_MIGRATION}: index postcondition failed for ${idx.name}`)
    }
  }
}
