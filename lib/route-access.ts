/**
 * Paths that are reachable without a signed-in session.
 *
 * Kept as a standalone, pure function (rather than inlined in proxy.ts) so it
 * can be unit tested directly — the proxy.ts middleware itself is wrapped by
 * next-auth's `auth()` helper and isn't easily testable in isolation.
 */
/**
 * Note on OAuth: `/oauth/authorize` and `/oauth/consent` are deliberately
 * **not** listed below. The authorize endpoint's first question is "who is
 * this?", and it must hit the middleware auth redirect so an anonymous visitor
 * is sent to `/login` and returned afterward with the query string intact —
 * `client_id`, `redirect_uri`, `state`, `code_challenge`, `scope` and
 * `resource` all live there. Making either public would turn the one endpoint
 * that binds a token to a human into one that runs without a session.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    // Fixed-path signed relay authenticates HMAC in its handler.
    pathname === "/api/analytics/activity" ||
    pathname.startsWith("/_vercel/insights/") ||
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
    // OAuth discovery documents (RFC 8414 / RFC 9728 / OIDC Discovery). An MCP
    // client fetches these before any user exists, so a 302 to /login would
    // make the server look like it has no authorization server at all.
    pathname.startsWith("/.well-known/") ||
    // The OAuth authorization server's machine-to-machine endpoints. Each one
    // authenticates the *client* (client_id, and a client_secret where the
    // client registered one) rather than a browser session, and each returns a
    // proper OAuth error body — a 302 to /login would be unparseable to them.
    // Registration is unauthenticated by design: it happens before any user is
    // involved, so there is no session to gate it on (decision 2).
    pathname === "/api/oauth/token" ||
    pathname === "/api/oauth/register" ||
    pathname === "/api/oauth/revoke" ||
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
    // Outbound MCP connector gateway (ADR-0018): the cloud agent calls this from
    // inside a Vercel Sandbox with its own short-lived AGENT_TURN bearer, so there
    // is no browser session to redirect. The route itself admits *only* an
    // AGENT_TURN credential and returns JSON-RPC errors, which a 302 to /login
    // would be unparseable to.
    //
    // Matched on a slug-shaped segment rather than `startsWith("/api/integrations/")`
    // so a future integrations route is not silently public by default — the same
    // reasoning as the enumerated internal callbacks above. Note the *browser*
    // connect/callback flow deliberately lives elsewhere (/api/connectors/…) and is
    // NOT public: it needs the middleware login redirect to preserve its query string.
    /^\/api\/integrations\/mcp\/[a-z0-9][a-z0-9-]{0,31}$/.test(pathname) ||
    // Docs API routes use session auth internally — let them handle 401 themselves
    pathname.startsWith("/api/docs/") ||
    // Agent turn route uses session auth internally (returns 401, not a 302)
    pathname.startsWith("/api/agent/") ||
    // PM interview routes use session auth internally so API clients receive
    // an explicit 401 instead of a browser-login redirect.
    pathname === "/api/pm-interviews" ||
    pathname.startsWith("/api/pm-interviews/") ||
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
