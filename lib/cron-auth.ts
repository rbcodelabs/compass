import { timingSafeEqual } from "node:crypto"

/** Length-independent, then constant-time. Never leaks which secret matched. */
function secretMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** True when neither secret is configured: cron routes must answer 503 rather than run unauthenticated. */
export function cronAuthNotConfigured(): boolean {
  return !process.env.CRON_SECRET && !process.env.MIGRATION_SECRET
}

/**
 * Authorizes a cron invocation: `CRON_SECRET` as a bearer token (what Vercel Cron sends), with
 * `MIGRATION_SECRET` accepted as the manual-operator fallback (same trust boundary as /api/admin/*).
 */
export function authorizeCron(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET
  const migrationSecret = process.env.MIGRATION_SECRET
  if (!cronSecret && !migrationSecret) return false
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
  return (
    secretMatches(bearer, cronSecret) ||
    secretMatches(bearer, migrationSecret) ||
    secretMatches(request.headers.get("x-migration-secret") ?? undefined, migrationSecret)
  )
}

/** Vercel Cron identifies itself with a `vercel-cron/1.0` user agent. Informational only: never an authorization signal. */
export function looksLikeVercelCron(request: Request): boolean {
  return /^vercel-cron\//i.test(request.headers.get("user-agent") ?? "")
}
