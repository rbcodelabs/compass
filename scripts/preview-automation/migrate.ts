import { Pool } from "pg"
import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { applyMigrations, getMigrationStatus } from "../../lib/migrations/runner"
import { assertSchema, migrateToReady } from "./database"
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
      // `pending` is the runner's own applicable-and-unapplied set: it already
      // excludes migrations scoped to another environment and any settled by an
      // applied alternative (039/042). Comparing against the full `manifest`
      // here would never reach zero, because an applied 039 retires 042.
      return Number(indexes.rows[0].pending) === 0 && status.incompleteMigrations.length === 0 && status.pending.length === 0
    }, () => new Promise(resolve => setTimeout(resolve, 3000)))
  } finally { await pool.end() }
}
main().catch(() => { console.error("Scoped preview migration failed; no administrative fallback attempted"); process.exitCode = 1 })
