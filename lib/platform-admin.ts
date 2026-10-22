/**
 * Platform-admin gate for deployment-global operator tools (e.g. rebuilding
 * the in-app agent's golden sandbox snapshot).
 *
 * Membership is an allowlist of emails in PLATFORM_ADMIN_EMAILS
 * (comma-separated, case-insensitive). An unset or empty list authorizes
 * nobody — fail closed. This is deliberately separate from MIGRATION_SECRET,
 * which is a server-to-server credential that must never reach a browser.
 */

export function platformAdminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function isPlatformAdminEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const normalized = email?.trim().toLowerCase()
  if (!normalized) return false
  return platformAdminEmails(env).includes(normalized)
}

/** True when the signed-in session user is a platform admin. */
export function isPlatformAdminSession(
  session: { user?: { email?: string | null } | null } | null | undefined
): boolean {
  return isPlatformAdminEmail(session?.user?.email)
}
