import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { deleteAccount, planAccountDeletion, RetryableDeletionError } from "@/lib/account-deletion"

/**
 * Self-service account deletion for the signed-in user.
 *
 * Session-gated via auth() (this path is deliberately NOT in lib/route-access.ts's public list, so the
 * middleware also redirects anonymous callers). The user id always comes from the session, never from the
 * request, so there is no way to name another account.
 *
 *   GET    -> what deleting would involve: blockers (teams that need a new owner first) and the
 *             organizations/workspaces that only this user belongs to.
 *   DELETE -> performs it. Body: { confirmEmail: string, soleOwnedOrganizationIds?: string[] }.
 *             confirmEmail must equal the account's email (case-insensitive): a deliberate re-confirmation.
 *             soleOwnedOrganizationIds are the organizations the user confirmed would be deleted with the account; they must
 *             equal the set recomputed at delete time, else 409 (membership changed since the page was rendered).
 *             Same-origin only: a missing or foreign Origin, or Sec-Fetch-Site other than same-origin, is a 403.
 */

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } })

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return json({ error: "Unauthorized" }, 401)
  const prisma = getPrisma()
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } })
  if (!user) return json({ error: "Not found" }, 404)
  const plan = await planAccountDeletion(prisma, session.user.id)
  return json({ email: user.email, ...plan })
}

/** A browser always sends Origin on a non-GET fetch. Anything missing or foreign is refused (CSRF defence in depth). */
function isSameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin") return false
  const origin = request.headers.get("origin")
  if (!origin) return false
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Auth.js stores the session in `authjs.session-token` (`__Secure-` on https, chunked as `.0`, `.1` when large). */
async function clearSessionCookies() {
  const store = await cookies()
  for (const { name } of store.getAll()) {
    if (/session-token(\.\d+)?$/.test(name)) store.delete(name)
  }
}

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return json({ error: "Unauthorized" }, 401)

  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed" }, 403)

  // A cross-site form cannot send application/json without a CORS preflight, which this route never approves.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }
  const { confirmEmail, soleOwnedOrganizationIds } = (body ?? {}) as { confirmEmail?: unknown; soleOwnedOrganizationIds?: unknown }
  if (typeof confirmEmail !== "string") return json({ error: "confirmEmail is required" }, 400)
  if (soleOwnedOrganizationIds !== undefined && !(Array.isArray(soleOwnedOrganizationIds) && soleOwnedOrganizationIds.every((id) => typeof id === "string"))) {
    return json({ error: "soleOwnedOrganizationIds must be an array of ids" }, 400)
  }

  const prisma = getPrisma()
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true } })
  if (!user) return json({ error: "Not found" }, 404)
  if (confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    return json({ error: "The email you typed does not match your account email." }, 400)
  }

  let result
  try {
    result = await deleteAccount(prisma, session.user.id, { soleOwnedOrganizationIds: (soleOwnedOrganizationIds as string[] | undefined) ?? [] })
  } catch (error) {
    // Steps are idempotent and the user row goes last, so the account is intact enough to retry.
    console.error("[account-deletion] failed", error)
    return json({ error: error instanceof RetryableDeletionError ? error.message : "Your account could not be deleted. Please try again." }, 500)
  }

  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return json({ error: "Not found" }, 404)
    return json({ error: result.reason, blockers: result.plan.blockers, soleOwned: result.plan.soleOwned }, 409)
  }
  await clearSessionCookies()
  return json({ deleted: true, revocation: result.revocation })
}
