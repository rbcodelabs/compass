import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Use the Edge-compatible config (no Prisma adapter) so middleware can run
// in the Vercel Edge runtime without Node.js-only module restrictions.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname } = req.nextUrl

  const isPublic =
    pathname === "/" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/api/auth") ||
    // MCP route uses Bearer token auth — let it through so the route
    // handler can validate the API key and return 401 (not 302) on failure.
    pathname.startsWith("/api/mcp") ||
    // Migration route uses x-migration-secret header auth
    pathname.startsWith("/api/admin/migrate") ||
    // Public portal routes — no auth, workspace settings control access
    pathname.startsWith("/portal/") ||
    pathname.startsWith("/api/portal/")

  if (!isLoggedIn && !isPublic) {
    return Response.redirect(new URL("/login", req.nextUrl))
  }
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
