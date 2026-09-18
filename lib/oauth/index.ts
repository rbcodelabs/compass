/**
 * Pure, framework-free, DB-free helpers for Compass's OAuth authorization
 * server (docs/design/mcp-oauth-discovery.md).
 *
 * Nothing in here touches Prisma, `next/*`, or request state — the route
 * handlers built on top of it in later stages are what own all of that. Keep it
 * that way: the `.well-known` documents these back must stay static and DB-free
 * to fit inside Claude's 10 s discovery budget on a cold function.
 */
export * from "@/lib/oauth/constants"
export * from "@/lib/oauth/pkce"
export * from "@/lib/oauth/redirect-uri"
export * from "@/lib/oauth/tokens"
