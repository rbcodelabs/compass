/**
 * Pure, framework-free, DB-free helpers for Compass's OAuth authorization
 * server (docs/design/mcp-oauth-discovery.md).
 *
 * Nothing re-exported here touches Prisma, `next/*`, or request state — the
 * route handlers are what own all of that. Keep it that way: the `.well-known`
 * documents these back must stay static and DB-free to fit inside Claude's 10 s
 * discovery budget on a cold function.
 *
 * The database- and framework-bound modules alongside these — `clients`,
 * `codes`, `consent`, `grants`, `http`, `rate-limit` — are deliberately **not**
 * re-exported. Importing this barrel must never be able to drag Prisma or
 * `next/server` into a module that only wanted to hash a token.
 */
export * from "@/lib/oauth/constants"
export * from "@/lib/oauth/metadata"
export * from "@/lib/oauth/pkce"
export * from "@/lib/oauth/redirect-uri"
export * from "@/lib/oauth/resource"
export * from "@/lib/oauth/tokens"
