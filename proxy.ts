import { auth } from "@/auth";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
export const proxy = auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname } = req.nextUrl

  const isPublic =
    pathname === "/" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    // MCP route uses Bearer token auth — let it through so the route
    // handler can validate the API key and return 401 (not 302) on failure.
    pathname.startsWith("/api/mcp") ||
    // All admin routes use x-migration-secret header auth
    pathname.startsWith("/api/admin/") ||
    // Public portal routes — no auth, workspace settings control access
    pathname.startsWith("/portal/") ||
    pathname.startsWith("/api/portal/") ||
    // Docs API routes use session auth internally — let them handle 401 themselves
    pathname.startsWith("/api/docs/") ||
    // Product docs — public, no auth required
    pathname.startsWith("/help")

  if (!isLoggedIn && !isPublic) {
    return Response.redirect(new URL("/login", req.nextUrl))
  }
})


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
