import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal } from "@/lib/migrations/workspace-id-on-solution-objective"

export const WORKSPACE_MODULES_MIGRATION = "107_workspace_modules"
export const WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION = "108_workspace_modules_legacy_flag_backfill"

/**
 * The environment flags the modules replace, mapped to the module each one switched on. Only the exact value "1" counts: the old
 * code was fail-closed in production on "1", and a backfill must never switch on more than the old flag did. The mapping is frozen
 * here (not derived from the live registry) so the migration means the same thing forever.
 */
export const LEGACY_FLAG_MODULES = [
  { env: "COMPASS_RESEARCH_CAPTURE_ENABLED", moduleKey: "research_capture" },
  { env: "COMPASS_PM_INTERVIEW_ENABLED", moduleKey: "pm_interview" },
  { env: "COMPASS_RESEARCH_AUTHORITATIVE_VOICE_ENABLED", moduleKey: "research_voice_authoritative" },
  { env: "COMPASS_RESEARCH_BROWSER_VOICE_ENABLED", moduleKey: "research_voice_browser" },
  { env: "COMPASS_RESEARCH_DISCOVERY_VOICE_ENABLED", moduleKey: "research_voice_discovery" },
  { env: "WORKSPACE_UPDATES_ENABLED", moduleKey: "workspace_updates" },
  { env: "FOLLOWING_ENABLED", moduleKey: "following" },
] as const

const COLUMNS = [
  { column: "id", nullable: false, type: "uuid" },
  { column: "workspace_id", nullable: false, type: "uuid" },
  { column: "module_key", nullable: false, type: "character varying" },
  { column: "enabled", nullable: false, type: "boolean" },
  { column: "updated_by_user_id", nullable: true, type: "uuid" },
  { column: "created_at", nullable: false, type: "timestamp without time zone" },
  { column: "updated_at", nullable: false, type: "timestamp without time zone" },
] as const
const INDEX = "workspace_modules_workspace_id_module_key_key"
const PAGE = 500

/**
 * Inserts an enabled `moduleKey` row for every workspace matching `where` that has no row for it yet. Find-then-insert (no ON CONFLICT,
 * which is unproven against DSQL's async unique indexes) in pages of 500, one small statement each. Never touches an existing row, so
 * an administrator's choice always wins and a re-run changes nothing. Returns the number of rows inserted.
 */
async function insertMissingEnabledRows(client: PoolClient, schema: string, moduleKey: string, where = "TRUE"): Promise<number> {
  let inserted = 0
  for (;;) {
    const page = await client.query<{ id: string }>(
      `SELECT w.id FROM "${schema}"."workspaces" w
        WHERE ${where} AND NOT EXISTS (SELECT 1 FROM "${schema}"."workspace_modules" m WHERE m.workspace_id = w.id AND m.module_key = $1)
        ORDER BY w.id LIMIT ${PAGE}`,
      [moduleKey],
    )
    if (page.rows.length === 0) return inserted
    for (const { id } of page.rows) {
      await client.query(
        `INSERT INTO "${schema}"."workspace_modules" (workspace_id, module_key, enabled, created_at, updated_at) VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, moduleKey],
      )
      inserted++
    }
  }
}

/** Data half of 107: fold the legacy workspaces.launch_workflow_enabled column into launch_workflow rows. Idempotent. */
export async function backfillLaunchWorkflowModules(client: PoolClient, schema: string, log: string[]): Promise<number> {
  const inserted = await insertMissingEnabledRows(client, schema, "launch_workflow", "w.launch_workflow_enabled IS TRUE")
  log.push(`  launch_workflow: ${inserted} workspace(s) carried over from workspaces.launch_workflow_enabled`)
  return inserted
}

/**
 * Postcondition for 107, run before its receipt: the table has exactly the intended columns, its unique index is valid, ready, unique,
 * non-partial and on (workspace_id, module_key), and every workspace whose legacy launch column is on has a launch_workflow row (any
 * value: an administrator may already have switched it off).
 */
export async function assertWorkspaceModulesMigration(client: PoolClient, schema: string) {
  const result = await client.query<{ column_name: string; is_nullable: string; data_type: string }>(
    "SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='workspace_modules'",
    [schema],
  )
  const actual = new Map(result.rows.map((row) => [row.column_name, row]))
  for (const { column, nullable, type } of COLUMNS) {
    const row = actual.get(column)
    if (!row || (row.is_nullable === "YES") !== nullable || row.data_type !== type) {
      throw new Error(`Migration 107 postcondition failed: workspace_modules.${column} is missing or has the wrong type or nullability`)
    }
  }

  const index = await client.query<{ valid: boolean; ready: boolean; unique: boolean; table_name: string; columns: string[]; predicate: string | null }>(
    `SELECT i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,t.relname AS table_name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,position)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
      pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
    [schema, INDEX],
  )
  const row = index.rows[0]
  if (index.rows.length !== 1 || !row.valid || !row.ready || !row.unique || row.table_name !== "workspace_modules" || row.columns.join(",") !== "workspace_id,module_key" || row.predicate !== null) {
    throw new Error(`Migration 107 postcondition failed: index ${INDEX} is not ready or has drifted`)
  }

  const missing = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "${schema}"."workspaces" w WHERE w.launch_workflow_enabled IS TRUE
      AND NOT EXISTS (SELECT 1 FROM "${schema}"."workspace_modules" m WHERE m.workspace_id = w.id AND m.module_key = 'launch_workflow')`,
  )
  if (Number(missing.rows[0]?.n ?? "0") !== 0) {
    throw new Error(`Migration 107 postcondition failed: ${missing.rows[0].n} workspace(s) with the launch workflow on have no launch_workflow module row`)
  }
}

/** The modules whose legacy flag is exactly "1" in `env`. */
export function legacyFlagsSetIn(env: Record<string, string | undefined>): string[] {
  return LEGACY_FLAG_MODULES.filter(({ env: name }) => env[name] === "1").map(({ moduleKey }) => moduleKey)
}

/**
 * 108: for every legacy flag that is exactly "1" in the executing environment, give every existing workspace without a row an ENABLED
 * row for its module. Writes nothing for a flag that is unset or anything else. Dependencies are not enabled on a module's behalf.
 * Refuses unless 107 has been applied. Returns the rows inserted per module.
 */
export async function backfillLegacyFlagModules(client: PoolClient, schema: string, log: string[], env: Record<string, string | undefined> = process.env): Promise<Record<string, number>> {
  const table = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='workspace_modules'", [schema])
  if (table.rows.length === 0) throw new WorkspaceIdBackfillRefusal(`${WORKSPACE_MODULES_LEGACY_FLAG_BACKFILL_MIGRATION}: apply ${WORKSPACE_MODULES_MIGRATION} first`)
  const set = legacyFlagsSetIn(env)
  const inserted: Record<string, number> = {}
  if (set.length === 0) log.push("  no legacy feature flag is set to 1 in this environment: nothing to carry over (modules stay at their defaults, off)")
  for (const moduleKey of set) {
    inserted[moduleKey] = await insertMissingEnabledRows(client, schema, moduleKey)
    log.push(`  ${moduleKey}: ${inserted[moduleKey]} workspace(s) enabled from the legacy flag`)
  }
  return inserted
}

/** Postcondition for 108: every workspace has a row for each module whose legacy flag was set. */
export async function assertLegacyFlagBackfill(client: PoolClient, schema: string, env: Record<string, string | undefined> = process.env) {
  for (const moduleKey of legacyFlagsSetIn(env)) {
    const missing = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${schema}"."workspaces" w
        WHERE NOT EXISTS (SELECT 1 FROM "${schema}"."workspace_modules" m WHERE m.workspace_id = w.id AND m.module_key = $1)`,
      [moduleKey],
    )
    if (Number(missing.rows[0]?.n ?? "0") !== 0) {
      throw new Error(`Migration 108 postcondition failed: ${missing.rows[0].n} workspace(s) have no ${moduleKey} module row`)
    }
  }
}
