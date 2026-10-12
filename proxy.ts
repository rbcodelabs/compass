import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { NextResponse } from "next/server";
import { parseTicketPath, previewHost, ticketPrefixFromReferer } from "@/lib/v0-preview-proxy";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
export const proxy = auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname, search } = req.nextUrl

  // The v0 preview host serves nothing but /p/<ticket>/…: no Compass pages, no
  // Compass APIs. The ticket is the credential (see lib/v0-preview-proxy.ts).
  const previewOnlyHost = previewHost()
  if (previewOnlyHost && req.headers.get("host")?.toLowerCase() === previewOnlyHost) {
    const parsed = parseTicketPath(pathname)
    if (parsed) {
      const target = req.nextUrl.clone()
      target.pathname = `/api/v0-preview/${parsed.ticket}${parsed.rest === "/" ? "" : parsed.rest}`
      return NextResponse.rewrite(target)
    }
    // A root-relative request from inside a framed preview (/_next/static/…) lost its
    // prefix; the Referer still names the framed document, so send it back through it.
    const prefix = ticketPrefixFromReferer(req.headers.get("referer"), previewOnlyHost)
    if (prefix && !pathname.startsWith("//")) {
      const redirect = NextResponse.redirect(new URL(`${prefix}${pathname}${search}`, req.nextUrl), 307)
      redirect.headers.set("cache-control", "private, no-store")
      return redirect
    }
    return new NextResponse("Not found", { status: 404, headers: { "cache-control": "private, no-store" } })
  }

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
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
    // The preview host must also see /_next/static, /favicon.ico etc.: a framed v0
    // app requests them root-relative and they are recovered from the Referer.
    { source: "/:path*", has: [{ type: "host", value: "v0-preview\\..+" }] },
  ],
}
