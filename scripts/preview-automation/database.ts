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
/**
 * Whether a freshly migrated preview schema is actually finished, from the
 * authenticated status body plus the count of not-yet-valid indexes.
 *
 * Every term has to be something a retry can actually clear, or this loop
 * cannot terminate. That rules out two fields:
 *
 * - `incompleteMigrations` is per-attempt forensic history and never clears once
 *   a migration has failed even once, so gating on it was unsatisfiable for any
 *   schema where a migration failed and then succeeded.
 * - `unresolvedMigrations` clears on a successful retry, but not when no retry
 *   is possible. A decision migration writes its unfinished `_prisma_migrations`
 *   row before running any DDL, so a failed 039 leaves one forever; once 042
 *   repairs it, 039 is `notApplicable` ("satisfied by 042") and will never be
 *   attempted again — permanently unresolved, permanently not pending. That is
 *   the ADR-0006 path, not a hypothetical.
 *
 * So an unresolved name blocks readiness only while the runner still considers
 * it live here: registered in `manifest`, and not explained away in
 * `notApplicable`. Such a name is normally in `pending` too, which means this
 * term earns its keep in exactly one case — a status body that reports nothing
 * pending while attempt rows say otherwise, e.g. a driver that stops returning
 * booleans for `finished_at IS NOT NULL`. Declaring an empty schema ready is the
 * one outcome worse than failing to provision it.
 *
 * An unreadable status or index count throws instead of returning false: that is
 * a defect, and quietly waiting 180 attempts for it would hide the cause.
 */
export function previewMigrationsReady(status: { unresolvedMigrations?: unknown; pending?: unknown; manifest?: unknown; notApplicable?: unknown }, pendingIndexes: number) {
  const { unresolvedMigrations, pending, manifest, notApplicable } = status
  if (!Array.isArray(unresolvedMigrations) || !Array.isArray(pending) || !Array.isArray(manifest) || !Array.isArray(notApplicable)) {
    throw new Error("Migration status is missing unresolvedMigrations/pending/manifest/notApplicable; refusing to infer readiness")
  }
  if (!Number.isFinite(pendingIndexes)) throw new Error("Pending index count is not a number; refusing to infer readiness")
  const registered = new Set<unknown>(manifest)
  const explained = new Set(notApplicable.map((entry) => (entry as { name?: unknown } | null)?.name))
  const blocking = unresolvedMigrations.filter((name) => registered.has(name) && !explained.has(name))
  return pendingIndexes === 0 && pending.length === 0 && blocking.length === 0
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
