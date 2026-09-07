import { Pool } from "pg"
import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { provisioningStatements } from "./database"
import { required, resolveTarget } from "./resolve"
import { signLease } from "./lease"
import { appendFile } from "node:fs/promises"

async function main() {
  const target = await resolveTarget()
  // This script must run from the trusted default branch in its own CI job.
  if (required("PREVIEW_CONTROLLER_TRUSTED_REF") !== "refs/heads/main") throw new Error("Provisioning requires trusted main controller")
  const signer = new DsqlSigner({ hostname: required("PREVIEW_DSQL_HOST"), region: required("AWS_REGION"), expiresIn: 900 })
  const pool = new Pool({ host: required("PREVIEW_DSQL_HOST"), user: "admin", database: "postgres", ssl: true, password: () => signer.getDbConnectAdminAuthToken(), max: 1 })
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS "compass_preview_control"')
    await pool.query('CREATE TABLE IF NOT EXISTS "compass_preview_control"."schemas" (schema_name VARCHAR(63) PRIMARY KEY, pr INTEGER NOT NULL, sha VARCHAR(40) NOT NULL, deployment_id VARCHAR(100) NOT NULL, origin VARCHAR(255) NOT NULL, lease_expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, cleaning BOOLEAN NOT NULL DEFAULT FALSE, cleaning_started_at TIMESTAMP, last_activity TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    const found = await pool.query('SELECT * FROM "compass_preview_control"."schemas" WHERE schema_name=$1', [target.schema])
    if (found.rows.length && (found.rows[0].sha !== target.sha || found.rows[0].pr !== target.pr)) throw new Error("Preview registry identity mismatch")
    if (!found.rows.length) {
      const existing = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1", [target.schema])
      if (existing.rows.length) throw new Error("Refusing to adopt an unregistered schema")
      await pool.query('INSERT INTO "compass_preview_control"."schemas" (schema_name,pr,sha,deployment_id,origin,lease_expires_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP + INTERVAL \'2 hours\')', [target.schema,target.pr,target.sha,target.deploymentId,target.origin])
    }
    const expiresAt = Date.now() + 2 * 3600_000
    const claim = await pool.query('UPDATE "compass_preview_control"."schemas" SET lease_expires_at=$2 WHERE schema_name=$1 AND cleaning=FALSE RETURNING schema_name', [target.schema,new Date(expiresAt)])
    if (claim.rowCount !== 1) throw new Error("Schema cleanup has claimed this revision")
    for (const sql of provisioningStatements(target.schema, required("PREVIEW_RUNTIME_IAM_ROLE"), required("PREVIEW_MIGRATION_IAM_ROLE"))) {
      try { await pool.query(sql) } catch (error) {
        // Only object-exists is resumable; authorization and every other error stop provisioning.
        if (!error || typeof error !== "object" || !("code" in error) || !["42710", "42P06"].includes(String(error.code))) throw error
      }
    }
    await pool.query('UPDATE "compass_preview_control"."schemas" SET deployment_id=$2,origin=$3,last_activity=CURRENT_TIMESTAMP WHERE schema_name=$1', [target.schema,target.deploymentId,target.origin])
    const receipt = signLease({ ...target, expiresAt }, required("PREVIEW_AUTOMATION_PRIVATE_KEY"))
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `leaseReceipt=${receipt}\n`)
    else console.log(receipt)
  } finally { await pool.end() }
}
main().catch(() => { console.error("Trusted preview provisioning failed; inspect role/configuration prerequisites"); process.exitCode = 1 })
