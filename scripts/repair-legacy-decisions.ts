import { readFile } from "node:fs/promises"
import path from "node:path"
import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import { Pool } from "pg"
import {
  parseLegacyDecisionRepairManifest,
  repairLegacyDecisionRequests,
  type LegacyDecisionRepairClient,
} from "../lib/legacy-decision-repair.ts"

const HELP = `Repair legacy tracked-decision presentation revisions.

Usage:
  pnpm maintenance:repair-legacy-decisions -- --manifest <path> --schema <schema> [--env-file <path>] [--apply]

Safety:
  Dry-run is the default. --apply writes only allowlisted PENDING tracked-decision/v1
  requests whose current revision ID and fingerprint still match the manifest.
`

type CliOptions = { manifestPath: string; schema: string; envFile?: string; apply: boolean }

function optionValue(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`)
  return args[index + 1]
}

function parseArgs(args: string[]): CliOptions | null {
  args = args.filter((arg) => arg !== "--")
  if (args.includes("--help") || args.includes("-h")) return null
  const known = new Set(["--manifest", "--schema", "--env-file", "--apply"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!known.has(arg)) throw new Error(`Unknown argument: ${arg}`)
    if (arg !== "--apply") index += 1
  }
  const manifestPath = optionValue(args, "--manifest")
  const schema = optionValue(args, "--schema")
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("--schema must be an explicit lowercase PostgreSQL identifier.")
  return { manifestPath, schema, envFile: args.includes("--env-file") ? optionValue(args, "--env-file") : undefined, apply: args.includes("--apply") }
}

async function createClient(schema: string) {
  let pool: Pool
  let target: { engine: "POSTGRES" | "AURORA_DSQL"; host: string; database: string; user: string; schema: string }
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL)
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10_000, application_name: "compass-legacy-decision-repair" })
    target = { engine: "POSTGRES", host: url.hostname, database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), schema }
  } else {
    const host = process.env.PGHOST
    const region = process.env.AWS_REGION
    const user = process.env.PGUSER
    if (!host || !region || !user) throw new Error("Set DATABASE_URL for local PostgreSQL, or PGHOST, PGUSER, and AWS_REGION for Aurora DSQL.")
    const signer = new DsqlSigner({ hostname: host, region })
    pool = new Pool({
      host,
      port: 5432,
      database: process.env.PGDATABASE ?? "postgres",
      user,
      password: () => user === "admin" ? signer.getDbConnectAdminAuthToken() : signer.getDbConnectAuthToken(),
      ssl: true,
      max: 2,
      connectionTimeoutMillis: 10_000,
      application_name: "compass-legacy-decision-repair",
    })
    target = { engine: "AURORA_DSQL", host, database: process.env.PGDATABASE ?? "postgres", user, schema }
  }
  const client = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
  return { client, pool, target }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options) { console.log(HELP); return }
  if (options.envFile) process.loadEnvFile(path.resolve(options.envFile))
  const rawManifest = JSON.parse(await readFile(path.resolve(options.manifestPath), "utf8")) as unknown
  const manifest = parseLegacyDecisionRepairManifest(rawManifest)
  const { client, pool, target } = await createClient(options.schema)
  try {
    const report = await repairLegacyDecisionRequests(client as unknown as LegacyDecisionRepairClient, manifest, { apply: options.apply })
    console.log(JSON.stringify({ target, ...report }, null, 2))
    if (report.requests.some((item) => item.status === "ERROR" || item.status === "NOT_ELIGIBLE")) process.exitCode = 1
  } finally {
    await client.$disconnect()
    if (!pool.ended) await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
