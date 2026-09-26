import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";
import { safeCallbackUrl } from "@/lib/safe-callback-url";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
export const proxy = auth((req) => {
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
})


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
