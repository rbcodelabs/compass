import type { PoolClient } from "pg"

export const PORTAL_SESSION_WORKSPACE_MIGRATION = "125_portal_session_workspace"

/** Columns 125 must leave behind. Nullable: NULL means "issued before workspace binding" and is never honored. */
const EXPECTED_COLUMNS: { table: string; column: string; dataType: string }[] = [
  { table: "portal_sessions", column: "workspace_id", dataType: "uuid" },
  { table: "portal_verification_tokens", column: "workspace_id", dataType: "uuid" },
]

/** Postcondition run before 125's completion receipt; same fail-closed contract as the portal home template migration. */
export async function assertPortalSessionWorkspaceMigration(client: PoolClient, schema: string) {
  for (const { table, column, dataType } of EXPECTED_COLUMNS) {
    const result = await client.query<{ data_type: string; is_nullable: string }>(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
      [schema, table, column],
    )
    const row = result.rows[0]
    if (!row) throw new Error(`${PORTAL_SESSION_WORKSPACE_MIGRATION}: column postcondition failed: ${table}.${column} missing`)
    if (row.data_type !== dataType) {
      throw new Error(`${PORTAL_SESSION_WORKSPACE_MIGRATION}: type postcondition failed: ${table}.${column} is ${row.data_type}, expected ${dataType}`)
    }
    if (row.is_nullable !== "YES") {
      throw new Error(`${PORTAL_SESSION_WORKSPACE_MIGRATION}: nullability postcondition failed: ${table}.${column} is NOT NULL`)
    }
  }
}
