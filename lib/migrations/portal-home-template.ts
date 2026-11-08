import type { PoolClient } from "pg"

export const PORTAL_HOME_TEMPLATE_MIGRATION = "114_portal_home_template"

/** Columns 114 must leave on portal_home_layouts. Nullable: NULL means "editorial". */
const EXPECTED_COLUMNS: { column: string; dataType: string }[] = [
  { column: "draft_template", dataType: "character varying" },
  { column: "published_template", dataType: "character varying" },
]

/** Postcondition run before 114's completion receipt; same fail-closed contract as the docs publishing migration. */
export async function assertPortalHomeTemplateMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'portal_home_layouts' AND column_name = ANY($2)",
    [schema, EXPECTED_COLUMNS.map((entry) => entry.column)],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, dataType } of EXPECTED_COLUMNS) {
    const row = actual.get(column)
    if (!row) throw new Error(`${PORTAL_HOME_TEMPLATE_MIGRATION}: column postcondition failed: portal_home_layouts.${column} missing`)
    if (row.data_type !== dataType) {
      throw new Error(`${PORTAL_HOME_TEMPLATE_MIGRATION}: type postcondition failed: portal_home_layouts.${column} is ${row.data_type}, expected ${dataType}`)
    }
    if (row.is_nullable !== "YES") {
      throw new Error(`${PORTAL_HOME_TEMPLATE_MIGRATION}: nullability postcondition failed: portal_home_layouts.${column} is NOT NULL`)
    }
  }
}
