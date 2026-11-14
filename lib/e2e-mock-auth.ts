import getPrisma from "@/lib/db"
import { e2eMockAuthEnabled } from "@/lib/e2e-harness"

/** Marker proving this module is in an artifact: compass-e2e-mock-auth-v1 (scripts/assert-no-mock-auth.mjs fails a deploy build that has it). */
export const E2E_MOCK_AUTH_MARKER = "compass-e2e-mock-auth-v1"

/**
 * The body of the Credentials provider "dev-credentials": upsert a user by email and sign them in, no password.
 * Allowed in `next dev`, and in a production build that was compiled with COMPASS_E2E_MOCK_AUTH_BUILD=1 and is running in mock
 * mode (see e2eMockAuthEnabled). The guard is evaluated again on every call, not only when auth.ts chose its config at boot.
 * Fails closed: returns null (a failed sign-in) and does not touch the database.
 */
export async function authorizeMockUser(credentials: Partial<Record<string, unknown>> | undefined) {
  const allowed = process.env.NODE_ENV === "development" || (process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1" && e2eMockAuthEnabled())
  if (!allowed) return null
  const prisma = getPrisma()
  const email = (credentials?.email as string | undefined) ?? "dev@localhost.dev"
  // Upsert the dev user so the id is stable across restarts.
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: "Dev User", emailVerified: new Date() },
  })
  return { id: user.id, email: user.email, name: user.name }
}
