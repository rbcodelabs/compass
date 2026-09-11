import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTarget, required } from "./resolve"
const exec = promisify(execFile)
async function main() {
  const current = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim()
  const main = (await exec("git", ["rev-parse", "origin/main"])).stdout.trim()
  if (current !== main) throw new Error("Run lifecycle from reviewed default-branch checkout")
  const target = await resolveTarget()
  const base: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME }
  const metadata = { GITHUB_TOKEN: required("GITHUB_TOKEN"), PREVIEW_VERCEL_TOKEN: required("PREVIEW_VERCEL_TOKEN"), PREVIEW_VERCEL_TEAM_ID: required("PREVIEW_VERCEL_TEAM_ID"), PREVIEW_VERCEL_PROJECT_ID: required("PREVIEW_VERCEL_PROJECT_ID"), PREVIEW_DEPLOYMENT_ID: target.deploymentId }
  const aws = (kind: string) => ({ AWS_ACCESS_KEY_ID: required(`PREVIEW_${kind}_ACCESS_KEY_ID`), AWS_SECRET_ACCESS_KEY: required(`PREVIEW_${kind}_SECRET_ACCESS_KEY`), ...(process.env[`PREVIEW_${kind}_SESSION_TOKEN`] ? { AWS_SESSION_TOKEN: process.env[`PREVIEW_${kind}_SESSION_TOKEN`] } : {}), AWS_REGION: required("AWS_REGION") })
  const provision = await exec("pnpm", ["exec", "tsx", "scripts/preview-automation/provision.ts"], { env: { ...base, ...metadata, ...aws("PROVISION"), PREVIEW_CONTROLLER_TRUSTED_REF: "refs/heads/main", PREVIEW_DSQL_HOST: required("PREVIEW_DSQL_HOST"), PREVIEW_RUNTIME_IAM_ROLE: required("PREVIEW_RUNTIME_IAM_ROLE"), PREVIEW_MIGRATION_IAM_ROLE: required("PREVIEW_MIGRATION_IAM_ROLE"), PREVIEW_AUTOMATION_PRIVATE_KEY: required("PREVIEW_AUTOMATION_PRIVATE_KEY") } })
  const receipt = provision.stdout.trim()
  const dir = await mkdtemp(join(tmpdir(), "compass-preview-migrate-"))
  try {
    // Archive target source without running its install hooks or handing it provisioner credentials.
    await exec("git", ["archive", "--format=tar", `--output=${join(dir, "source.tar")}`, target.sha])
    await exec("tar", ["-xf", join(dir, "source.tar"), "-C", dir])
    await symlink(join(process.cwd(), "node_modules"), join(dir, "node_modules"))
    await exec("pnpm", ["exec", "tsx", "scripts/preview-automation/migrate.ts"], { cwd: dir, timeout: 900_000, env: { ...base, ...aws("MIGRATION"), PGHOST: required("PREVIEW_DSQL_HOST"), PGUSER: `${target.schema}_migrate`, PREVIEW_SCHEMA: target.schema } })
    await exec("pnpm", ["exec", "tsx", "scripts/preview-automation/probe.ts"], { env: { ...base, ...aws("RUNTIME"), PGHOST: required("PREVIEW_DSQL_HOST"), PREVIEW_SCHEMA: target.schema } })
    await exec("pnpm", ["exec", "tsx", "scripts/preview-automation/run.ts", ...(process.argv.includes("--explore") ? ["--explore"] : [])], { timeout: 3700_000, env: { ...base, ...metadata, PREVIEW_PROVISION_RECEIPT: receipt, PREVIEW_AUTOMATION_PUBLIC_KEY: required("PREVIEW_AUTOMATION_PUBLIC_KEY"), PREVIEW_AUTOMATION_PRIVATE_KEY: required("PREVIEW_AUTOMATION_PRIVATE_KEY"), PREVIEW_PROTECTION_BYPASS: required("PREVIEW_PROTECTION_BYPASS") } })
  } finally { await rm(dir, { recursive: true, force: true }) }
}
main().catch(() => { console.error("Preview lifecycle failed; resources remain registered for recovery. Check sanitized report and prerequisites."); process.exitCode = 1 })
