import type { PoolClient } from "pg"

/**
 * Postcondition assertion for migration 056_agent_scoped_oauth_binding.
 *
 * Mirrors assertOAuthAuthorizationServerMigration: the runner only writes a
 * finished receipt once this passes, so a half-applied migration stays visible
 * as an unfinished attempt rather than being recorded as done.
 *
 * Three things are checked, and each one has a distinct failure it prevents.
 *
 *  1. **Every column exists.** `validateOAuthAccessToken` selects
 *     `authorization_mode` and `agent_id` on the hot path for every MCP
 *     request. A receipt written while either is missing turns the next deploy
 *     into a total authentication outage rather than a migration to re-run.
 *
 *  2. **The backfill finished.** The columns are added nullable because DSQL
 *     rejects a DEFAULT on ALTER TABLE ADD COLUMN, so the "never null" property
 *     the design relies on is produced by an UPDATE, not by the schema. A
 *     receipt written with rows still NULL would record a completed migration
 *     over an incomplete invariant. A data migration must finish its
 *     postconditions before the receipt is written, so this is the assertion
 *     that makes the backfill real.
 *
 *  3. **idx_oauth_tokens_agent is valid.** It is created ASYNC, and a wait that
 *     times out leaves `indisvalid = false`. Unlike the 055 indexes this one is
 *     not a uniqueness constraint, so an invalid index is a performance problem
 *     rather than a correctness one — but it is still not "applied", and
 *     recording it as such is how an index silently never gets built.
 *
 * Deliberately NOT checked: that no row has `agent_id` set while
 * `authorization_mode <> 'AGENT'`. Nothing in this migration can produce that
 * state (it adds both columns empty), and asserting it here would be asserting
 * an application invariant from the migration runner, which is the wrong layer
 * — `validateOAuthAccessToken` enforces it per request, where it can actually
 * refuse.
 */

export const AGENT_SCOPED_OAUTH_COLUMNS = [
  "oauth_authorization_codes.authorization_mode",
  "oauth_authorization_codes.agent_id",
  "oauth_tokens.authorization_mode",
  "oauth_tokens.agent_id",
  "oauth_consents.authorization_mode",
  "oauth_consents.agent_id",
  "agent_tool_calls.credential_type",
] as const

export const AGENT_SCOPED_OAUTH_INDEXES = ["idx_oauth_tokens_agent"] as const

/**
 * Table → column pairs whose backfill must have left no NULLs behind. `agent_id`
 * is absent on purpose: null is its correct and overwhelmingly common value
 * (every USER-mode row), which is precisely why the mode needs its own column.
 */
const BACKFILLED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["oauth_authorization_codes", "authorization_mode"],
  ["oauth_tokens", "authorization_mode"],
  ["oauth_consents", "authorization_mode"],
  ["agent_tool_calls", "credential_type"],
]

/**
 * These stay nullable. `authorization_mode` and `credential_type` are nullable
 * because DSQL will not accept a DEFAULT on ADD COLUMN and a NOT NULL without
 * one cannot be added to a populated table; `agent_id` is nullable because
 * USER-mode tokens have no agent. The columns stay nullable for DSQL schema
 * compatibility, but readers accept only exact "USER" or "AGENT" values and
 * fail closed if a null or unknown value survives the migration backfill.
 */
const NULLABLE_COLUMNS = AGENT_SCOPED_OAUTH_COLUMNS

type ColumnRow = { table_name: string; column_name: string; is_nullable: string }
type IndexRow = { name: string; valid: boolean }

export async function assertAgentScopedOAuthBindingMigration(client: PoolClient, schema: string) {
  const tables = [...new Set(AGENT_SCOPED_OAUTH_COLUMNS.map((column) => column.split(".")[0]))]
  const columns = await client.query<ColumnRow>(
    "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, tables],
  )
  const byName = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))

  const missing = AGENT_SCOPED_OAUTH_COLUMNS.filter((column) => !byName.has(column))
  if (missing.length > 0) {
    throw new Error(`Migration 056 postcondition failed: missing column(s) ${missing.join(", ")}.`)
  }

  const wronglyRequired = NULLABLE_COLUMNS.filter((column) => byName.get(column)!.is_nullable !== "YES")
  if (wronglyRequired.length > 0) {
    throw new Error(
      `Migration 056 postcondition failed: column(s) must be nullable: ${wronglyRequired.join(", ")}.`,
    )
  }

  for (const [table, column] of BACKFILLED_COLUMNS) {
    // Identifiers are from the module-level literal above, never from input.
    const remaining = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${schema}"."${table}" WHERE "${column}" IS NULL`,
    )
    if (remaining.rows[0]?.count !== "0") {
      throw new Error(
        `Migration 056 postcondition failed: ${table}.${column} still has ${remaining.rows[0]?.count} unbackfilled row(s).`,
      )
    }
  }

  const indexes = await client.query<IndexRow>(
    "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])",
    [schema, [...AGENT_SCOPED_OAUTH_INDEXES]],
  )
  const unhealthy = AGENT_SCOPED_OAUTH_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.valid),
  )
  if (unhealthy.length > 0) {
    throw new Error(
      `Migration 056 postcondition failed: index(es) missing or not valid: ${unhealthy.join(", ")}.`,
    )
  }
}
