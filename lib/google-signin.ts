/**
 * Google sign-in is served by a Vercel Connect connector, named by
 * `COMPASS_GOOGLE_CONNECTOR` (the same env var the Drive connector uses, so one
 * Google OAuth client backs both). It has no default and no legacy fallback:
 * unset means the Google provider is not registered and the login page omits its
 * button, while magic link and passkey keep working.
 */
import { GOOGLE_CONNECTOR_ENV } from "@/lib/mcp-connectors/config"

export function googleConnectorUid(): string | null {
  return process.env[GOOGLE_CONNECTOR_ENV]?.trim() || null
}

export function googleSignInEnabled(): boolean {
  return googleConnectorUid() !== null
}

/**
 * The profile mapper wrapped with the email-verification gate.
 *
 * `allowDangerousEmailAccountLinking` links a Google sign-in to an existing user
 * by email, which is only safe if the provider vouches for the address. Vercel
 * Connect's mapper drops `email_verified`, so the vouching is re-checked here
 * against the raw userinfo claims: anything but a literal `true` is refused.
 */
export function requireVerifiedGoogleEmail<T extends { email_verified?: unknown; email?: unknown }>(
  profile: T,
): T {
  if (typeof profile.email !== "string" || !profile.email)
    throw new Error("Google sign-in refused: the account has no email address.")
  if (profile.email_verified !== true)
    throw new Error("Google sign-in refused: the Google email address is not verified.")
  return profile
}
