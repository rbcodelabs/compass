import { Pool } from "pg"
import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { applyMigrations, getMigrationStatus } from "../../lib/migrations/runner"
import { assertSchema, migrateToReady, previewMigrationsReady } from "./database"
import { required } from "./resolve"

async function main() {
  const schema = required("PREVIEW_SCHEMA")
  assertSchema(schema)
  if (process.env.DATABASE_URL || process.env.PGUSER !== `${schema}_migrate`) throw new Error("Migration worker requires a scoped preview role")
  const signer = new DsqlSigner({ hostname: required("PGHOST"), region: required("AWS_REGION"), expiresIn: 900 })
  const pool = new Pool({ host: required("PGHOST"), user: `${schema}_migrate`, database: "postgres", port: 5432, ssl: true, password: () => signer.getDbConnectAuthToken(), max: 1 })
  try {
    await migrateToReady(async () => (await applyMigrations(pool, schema, undefined, { preProvisionedSchema: true })).status, async () => {
      const status = await (await getMigrationStatus(pool, schema)).json()
      const indexes = await pool.query("SELECT COUNT(*) AS pending FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND (NOT i.indisvalid OR NOT i.indisready)", [schema])
      // Both halves of this gate read the runner's grouped current state, not
      // its raw history. `pending` is the applicable-and-unapplied set, which
      // already excludes migrations scoped to another environment and any
      // settled by an applied alternative (039/042) — comparing against the full
      // `manifest` would never reach zero, because an applied 039 retires 042.
      // `unresolvedMigrations` is the same idea for failed attempts: it clears
      // when a retry succeeds, where `incompleteMigrations` never does.
      return previewMigrationsReady(status, Number(indexes.rows[0].pending))
    }, () => new Promise(resolve => setTimeout(resolve, 3000)))
  } finally { await pool.end() }
}
// The reason is logged, not just the refusal: `previewMigrationsReady` throws on
// a status body it cannot read precisely so that cause is visible, which a
// discarded error would undo.
main().catch((error) => { console.error("Scoped preview migration failed; no administrative fallback attempted", error instanceof Error ? error.message : error); process.exitCode = 1 })
