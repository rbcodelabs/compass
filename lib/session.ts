import { cache } from "react"
import type { Session } from "next-auth"
import { auth } from "@/auth"

/**
 * The request-memoized read of the Auth.js session.
 *
 * `auth.ts` branches on NODE_ENV. In **development** it uses the Credentials
 * provider with `session: { strategy: "jwt" }` and no adapter, so `auth()`
 * decrypts a cookie and costs nothing. In **production and preview** it passes
 * `adapter: createLazyPrismaAuthAdapter()` with no explicit `session.strategy`,
 * which makes Auth.js default to the *database* strategy — so every raw
 * `auth()` is a `session.findUnique({ include: { user: true } })` (two
 * statements, since `relationJoins` is off) plus a possible rolling-expiry
 * UPDATE on the session row.
 *
 * Nothing memoizes that. Rendering one authenticated page called it from the
 * workspace layout, each nested layout, `generateMetadata`, and the page
 * itself — roughly six statements per render just to answer "who is this".
 *
 * This is the same mechanism and the same motivation as `getPortalSession()`
 * (lib/portal-auth.ts), which was introduced after un-memoized duplicate calls
 * caused a real production incident: each call issued its own write against the
 * same session row, and Aurora DSQL's optimistic concurrency control throws a
 * write conflict (Prisma P2034) rather than blocking. The authenticated side
 * has the same exposure — `tasks/[taskId]/page.tsx` calls into the session from
 * both `generateMetadata` and the page component, and those run *concurrently*,
 * so when the rolling-expiry window opens they are two concurrent UPDATEs on
 * one row. Memoizing removes that, not just the latency.
 *
 * Deliberately lives here rather than in `auth.ts`:
 *   - `auth.ts` is imported by `proxy.ts`, which runs as its own invocation
 *     with its own request scope. Memoization can never span proxy -> RSC, and
 *     pulling React into the proxy module graph buys nothing.
 *   - `auth` is overloaded (`auth()`, `auth(req => ...)`, and the route-handler
 *     form). Only the zero-argument RSC form is safe to memoize. Leaving the
 *     raw export untouched and exposing one narrow cached read here makes the
 *     safe form the convenient one.
 *
 * Do NOT use this on the sign-in/sign-out paths (`app/login/page.tsx`,
 * `lib/actions/auth-actions.ts`). Those are the only places where the session
 * changes mid-request, and a memoized read would be stale.
 */
export const getSession = cache(async (): Promise<Session | null> => auth())

export type SessionUser = {
  id: string
  name: string | null
  email: string | null
  image: string | null
}

/**
 * Narrowed, request-memoized read: null unless there is a session carrying a
 * user id.
 *
 * Every caller in the workspace tree does `if (!session?.user?.id)` and then
 * reads only id/name/email/image. Returning a non-nullable `id` here removes
 * that optional-chaining dance (and the non-null assertions it otherwise
 * forces) at ~20 call sites.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getSession()
  if (!session?.user?.id) return null
  const { id, name, email, image } = session.user
  return {
    id,
    name: name ?? null,
    email: email ?? null,
    image: image ?? null,
  }
})
