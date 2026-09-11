/**
 * Paths that are reachable without a signed-in session.
 *
 * Kept as a standalone, pure function (rather than inlined in proxy.ts) so it
 * can be unit tested directly — the proxy.ts middleware itself is wrapped by
 * next-auth's `auth()` helper and isn't easily testable in isolation.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    ["/api/preview-automation/bootstrap", "/api/preview-automation/session", "/api/preview-automation/teardown"].includes(pathname) ||
    // ADR-0009 preview-login page + its start route. Both fail closed
    // internally (404 before any DB access) unless VERCEL_ENV=preview and
    // PREVIEW_LOGIN_ENABLED=1, so making them reachable without a session
    // here does not widen access on production or non-opted-in previews —
    // it only lets an anonymous visitor reach the gate at all, which is the
    // entire point of a login page.
    pathname === "/preview-login" ||
    pathname === "/api/preview-login/start" ||
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
    // Participant research routes use a hashed, expiring study token. Their
    // API handlers validate the token and session-to-study scope themselves.
    pathname.startsWith("/research/") ||
    pathname.startsWith("/api/research/") ||
    // Only these internal callbacks bypass browser login; each requires its bound worker bearer.
    /^\/api\/internal\/research\/voice\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/(?:heartbeat|events|commands\/(?:claim|result))$/i.test(pathname) ||
    // Docs API routes use session auth internally — let them handle 401 themselves
    pathname.startsWith("/api/docs/") ||
    // Agent turn route uses session auth internally (returns 401, not a 302)
    pathname.startsWith("/api/agent/") ||
    // Product docs — public, no auth required
    pathname.startsWith("/help") ||
    // Repository-native UI registry. The page itself returns 404 in production
    // unless COMPASS_UI_REGISTRY=1; keeping the route public makes the enabled
    // registry deterministic and independent of session/database fixtures.
    pathname === "/ui" ||
    // Images referenced by the public product docs (e.g. /help/02-discovery
    // embeds /screenshots/docs/discovery-board.png) — served from public/,
    // so the middleware matcher catches them like any other route. Without
    // this, every screenshot in the public docs 302s to /login for anyone
    // without a session, making the images appear broken.
    pathname.startsWith("/screenshots")
  )
}
