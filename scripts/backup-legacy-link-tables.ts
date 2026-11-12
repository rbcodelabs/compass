#!/usr/bin/env node
/**
 * Pre-drop backup for migration 116 (docs/maintenance/entity-links-legacy-drop.md). READ-ONLY against the database, except `restore`.
 *
 *   npx tsx scripts/backup-legacy-link-tables.ts export  --schema <schema> --out <new-dir>
 *   npx tsx scripts/backup-legacy-link-tables.ts verify  --schema <schema> --out <dir>      (offline: row counts and checksums of the files)
 *   npx tsx scripts/backup-legacy-link-tables.ts restore --schema <schema> --out <dir> --yes (emergency: loads rows into tables you recreated)
 *
 * Connection, plain Postgres (rbcodelabs production on Supabase): DATABASE_MIGRATION_URL (session pooler, port 5432) or POSTGRES_URL_NON_POOLING or
 * DATABASE_URL, the same order the migrate route uses. Aurora DSQL (the work deployment): PGHOST (+ PGUSER, PGDATABASE, AWS_REGION) with AWS
 * credentials in the environment; an admin IAM token is generated for the connection.
 *
 * Nothing in this repository runs it. The operator runs it against the real database, once, right before the 116 POST, and stores the output
 * directory somewhere durable and private (it contains link rows: ids, workspace ids and users, but no titles or content).
 */
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import { getMigrationDatabaseUrl, getPoolerMode } from "@/lib/db-url"
import { exportLegacyLinks, restoreLegacyLinks, verifyBackup, type BackupQuery } from "@/lib/migrations/legacy-link-backup"

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 ? process.argv[index + 1] : undefined
}

async function connect(): Promise<Pool> {
  const url = getMigrationDatabaseUrl(process.env)
  if (url) {
    if (getPoolerMode(url, process.env) === "transaction") throw new Error("Use a session-mode or direct connection (port 5432), not the transaction pooler.")
    return new Pool({ connectionString: url, max: 1 })
  }
  const host = process.env.PGHOST
  if (!host) throw new Error("Set DATABASE_MIGRATION_URL (plain Postgres) or PGHOST (Aurora DSQL).")
  const { DsqlSigner } = await import("@aws-sdk/dsql-signer")
  const signer = new DsqlSigner({ hostname: host, region: process.env.AWS_REGION ?? "us-east-1", expiresIn: 900 })
  return new Pool({ host, user: process.env.PGUSER ?? "admin", database: process.env.PGDATABASE ?? "postgres", password: () => signer.getDbConnectAdminAuthToken(), port: 5432, ssl: true, max: 1 })
}

const command = process.argv[2]
const schema = arg("schema")
const out = arg("out")
if (!command || !schema || !out) {
  console.error("usage: backup-legacy-link-tables.ts export|verify|restore --schema <schema> --out <dir> [--yes]")
  process.exit(64)
}
const dir = path.resolve(out)

if (command === "verify") {
  const manifest = verifyBackup(dir, schema)
  console.log(`OK ${schema}: ${Object.entries(manifest.relations).map(([name, entry]) => `${name}=${"absent" in entry ? "absent" : entry.rows}`).join(" ")} (entity_links rows at backup time: ${manifest.entityLinksRows})`)
} else if (command === "export" || command === "restore") {
  if (command === "restore" && !process.argv.includes("--yes")) throw new Error("restore writes to the database; pass --yes once you have recreated the tables")
  if (command === "export") mkdirSync(dir, { recursive: true, mode: 0o700 })
  const pool = await connect()
  const query: BackupQuery = async (sql, params) => pool.query(sql, params as unknown[])
  try {
    if (command === "export") {
      const manifest = await exportLegacyLinks(query, schema, dir)
      verifyBackup(dir, schema)
      console.log(`Exported and verified ${schema} to ${dir}`)
      for (const [name, entry] of Object.entries(manifest.relations)) console.log(`  ${name}: ${"absent" in entry ? "absent (already dropped)" : `${entry.rows} rows, sha256 ${entry.sha256}`}`)
      console.log(`  entity_links rows now: ${manifest.entityLinksRows}`)
    } else {
      console.log(JSON.stringify(await restoreLegacyLinks(query, schema, dir)))
    }
  } finally {
    await pool.end()
  }
} else {
  console.error(`unknown command ${command}`)
  process.exit(64)
}
