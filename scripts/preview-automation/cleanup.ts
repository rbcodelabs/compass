import { Pool } from "pg"
import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { assertSchema, cleanupEligible } from "./database"
import { signGrant, originHeaders } from "./contracts"
import { required } from "./resolve"

async function main() {
  if (required("PREVIEW_CONTROLLER_TRUSTED_REF") !== "refs/heads/main") throw new Error("Cleanup requires trusted main")
  const signer = new DsqlSigner({ hostname: required("PREVIEW_DSQL_HOST"), region: required("AWS_REGION"), expiresIn: 900 })
  const pool = new Pool({ host: required("PREVIEW_DSQL_HOST"), user: "admin", database: "postgres", ssl: true, password: () => signer.getDbConnectAdminAuthToken(), max: 1 })
  try {
    const registry = await pool.query('SELECT * FROM "compass_preview_control"."schemas"')
    for (const record of registry.rows) {
      const schema = String(record.schema_name); assertSchema(schema)
      const hasRuns = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='preview_automation_runs'", [schema])
      let activeRuns = 0
      if (hasRuns.rows.length) {
        const expired = await pool.query(`SELECT id,deployment_id,owner_user_id,viewer_user_id FROM "${schema}".preview_automation_runs WHERE expires_at<=CURRENT_TIMESTAMP AND cleaned_at IS NULL LIMIT 100`)
        for (const run of expired.rows) {
          await pool.query(`UPDATE "${schema}".preview_automation_runs SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1 AND revoked_at IS NULL`, [run.id])
          await pool.query(`DELETE FROM "${schema}".sessions WHERE user_id IN ($1,$2)`, [run.owner_user_id,run.viewer_user_id])
          if (!/^dpl_[A-Za-z0-9]+$/.test(run.deployment_id)) throw new Error("Invalid run deployment")
          const deploymentResponse = await fetch(`https://api.vercel.com/v13/deployments/${run.deployment_id}?teamId=${encodeURIComponent(required("PREVIEW_VERCEL_TEAM_ID"))}`, { headers: { Authorization: `Bearer ${required("PREVIEW_VERCEL_TOKEN")}` }, redirect: "error" })
          if (!deploymentResponse.ok) { console.error("Run deployment unavailable; sessions revoked, data retained for later schema cleanup"); continue }
          const deployment = await deploymentResponse.json()
          if (deployment.projectId !== required("PREVIEW_VERCEL_PROJECT_ID") || deployment.id !== run.deployment_id || deployment.target === "production" || deployment.meta?.githubCommitSha !== record.sha || !/^[a-z0-9-]+\.vercel\.app$/.test(deployment.url) || /\s/.test(deployment.url)) throw new Error("Run deployment identity mismatch")
          const origin = `https://${deployment.url}`
          const response = await fetch(`${origin}/api/preview-automation/teardown`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json", ...originHeaders(origin, origin, required("PREVIEW_PROTECTION_BYPASS")), Authorization: `Bearer ${signGrant({ origin, deploymentId: run.deployment_id, runId: run.id, operation: "teardown" }, required("PREVIEW_AUTOMATION_PRIVATE_KEY"))}` }, body: "{}" })
          if (!response.ok) console.error(`Expired run cleanup deferred (${response.status})`)
        }
        activeRuns = Number((await pool.query(`SELECT COUNT(*) AS count FROM "${schema}".preview_automation_runs WHERE expires_at>CURRENT_TIMESTAMP AND revoked_at IS NULL`)).rows[0].count)
      }
      if (new Date(record.lease_expires_at).getTime() > Date.now()) continue
      const prResponse = await fetch(`https://api.github.com/repos/rbcodelabs/compass/pulls/${Number(record.pr)}`, { headers: { Authorization: `Bearer ${required("GITHUB_TOKEN")}` }, redirect: "error" })
      if (!prResponse.ok) throw new Error("Cannot verify PR lifecycle; cleanup stopped")
      const pr = await prResponse.json()
      if (!cleanupEligible({ registered: true, activeRuns, closed: pr.state === "closed", lastActivity: new Date(record.last_activity).getTime(), leaseExpiresAt: new Date(record.lease_expires_at).getTime() })) continue
      // Atomic claim fences a concurrent provisioner; claimed rows cannot issue new leases.
      const claim = await pool.query('UPDATE "compass_preview_control"."schemas" SET cleaning=TRUE,cleaning_started_at=CURRENT_TIMESTAMP WHERE schema_name=$1 AND lease_expires_at<=CURRENT_TIMESTAMP AND (cleaning=FALSE OR cleaning_started_at<CURRENT_TIMESTAMP - INTERVAL \'15 minutes\') RETURNING schema_name', [schema])
      if (claim.rowCount !== 1) continue
      // No CASCADE and no wildcard deletion: enumerate only this exact registered namespace.
      const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE'", [schema])
      for (const { table_name: table } of tables.rows) {
        if (typeof table !== "string" || !/^[a-zA-Z0-9_]+$/.test(table)) throw new Error("Unexpected table identifier")
        await pool.query(`DROP TABLE IF EXISTS "${schema}"."${table}"`)
      }
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}"`)
      for (const [suffix, variable] of [["runtime", "PREVIEW_RUNTIME_IAM_ROLE"], ["migrate", "PREVIEW_MIGRATION_IAM_ROLE"]]) {
        const role = `${schema}_${suffix}`, arn = required(variable)
        if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(arn) || /\s/.test(arn)) throw new Error("Invalid role mapping")
        const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])
        if (exists.rows.length) {
          await pool.query(`AWS IAM REVOKE "${role}" FROM '${arn}'`)
          await pool.query(`DROP ROLE "${role}"`)
        }
      }
      await pool.query('DELETE FROM "compass_preview_control"."schemas" WHERE schema_name=$1', [schema])
    }
  } finally { await pool.end() }
}
main().catch(() => { console.error("Preview recovery failed; registered resources retained for retry"); process.exitCode = 1 })
