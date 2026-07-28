/**
 * Paths that are reachable without a signed-in session.
 *
 * Kept as a standalone, pure function (rather than inlined in proxy.ts) so it
 * can be unit tested directly — the proxy.ts middleware itself is wrapped by
 * next-auth's `auth()` helper and isn't easily testable in isolation.
 */
export function isPublicPath(pathname: string): boolean {
  return (
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
    pathname.startsWith("/help") ||
    // Images referenced by the public product docs (e.g. /help/02-discovery
    // embeds /screenshots/docs/discovery-board.png) — served from public/,
    // so the middleware matcher catches them like any other route. Without
    // this, every screenshot in the public docs 302s to /login for anyone
    // without a session, making the images appear broken.
    pathname.startsWith("/screenshots")
  )
}
