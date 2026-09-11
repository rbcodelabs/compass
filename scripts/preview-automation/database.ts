export function assertSchema(schema: string) {
  if (!/^compass_pr_[1-9]\d{0,9}_[a-f0-9]{12}$/.test(schema)) throw new Error("Invalid registered preview schema")
}
export function provisioningStatements(schema: string, runtimeIam: string, migrationIam: string) {
  assertSchema(schema)
  for (const arn of [runtimeIam, migrationIam]) if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(arn)) throw new Error("Invalid preview IAM role")
  const runtime = `${schema}_runtime`, migration = `${schema}_migrate`
  return [
    `CREATE ROLE "${runtime}" WITH LOGIN`,
    `CREATE ROLE "${migration}" WITH LOGIN`,
    `AWS IAM GRANT "${runtime}" TO '${runtimeIam}'`,
    `AWS IAM GRANT "${migration}" TO '${migrationIam}'`,
    `CREATE SCHEMA "${schema}" AUTHORIZATION "${migration}"`,
    `REVOKE ALL ON SCHEMA "${schema}" FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA "${schema}" TO "${runtime}"`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtime}"`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${migration}" IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtime}"`,
  ]
}
export function cleanupEligible(record: { registered: boolean; activeRuns: number; closed: boolean; lastActivity: number; leaseExpiresAt?: number }, now = Date.now()) {
  return record.registered && record.activeRuns === 0 && (record.leaseExpiresAt === undefined || (Number.isFinite(record.leaseExpiresAt) && record.leaseExpiresAt <= now)) && (record.closed || now - record.lastActivity >= 7 * 86400_000)
}
export async function migrateToReady(apply: () => Promise<number>, ready: () => Promise<boolean>, pause: () => Promise<void>, attempts = 180) {
  for (let i = 0; i < attempts; i++) {
    const status = await apply()
    if (status !== 200 && status !== 202) throw new Error(`Preview migration failed (${status})`)
    if (status === 200 && await ready()) return
    await pause()
  }
  throw new Error("Preview migrations did not become ready before deadline")
}
