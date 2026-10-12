import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { retiredOrgSlugRedirectTarget } from "@/lib/org-slug-redirect";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
export const proxy = auth(async (req) => {
  const isLoggedIn = !!req.auth
  const { pathname, search } = req.nextUrl

  if (!isLoggedIn && !isPublicPath(pathname)) {
    const loginUrl = new URL("/login", req.nextUrl)
    // Preserve where the visitor was actually going. /oauth/authorize carries
    // client_id, redirect_uri, state, code_challenge, resource and scope in its
    // query string; redirecting to a bare /login discards all of it and breaks
    // the OAuth flow for anyone not already signed in — which is the common
    // case, since MCP clients open a fresh browser. safeCallbackUrl re-validates
    // on the /login side, so this is one of two independent checks.
    loginUrl.searchParams.set("callbackUrl", safeCallbackUrl(`${pathname}${search}`))
    return Response.redirect(loginUrl)
  }

  // An organization that has renamed its URL slug keeps its old links working:
  // /{old}/..., /portal/{old}/... and /api/portal/{old}/... redirect to the same
  // path under the current slug (lib/org-slug.ts). Runs after the login check so an
  // anonymous visitor is never told what an org is now called, but before the
  // pages so a retired slug never reaches a "not found" branch. 307, not 308:
  // browsers cache a permanent redirect forever, which would break renaming back.
  // Programmatic APIs (/api/mcp, /api/v1) are excluded on purpose.
  const retiredSlugTarget = await retiredOrgSlugRedirectTarget(pathname, search)
  if (retiredSlugTarget) {
    return Response.redirect(new URL(retiredSlugTarget, req.nextUrl), 307)
  }
})


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
