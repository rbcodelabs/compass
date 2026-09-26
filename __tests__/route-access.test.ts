import { describe, it, expect } from "vitest";
import { isPublicPath } from "@/lib/route-access";

describe("isPublicPath", () => {
  it("allows the marketing root", () => {
    expect(isPublicPath("/")).toBe(true);
  });

  it("allows auth-related routes", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/callback/google")).toBe(true);
  });

  it("allows the MCP endpoint (Bearer-token auth handled by the route itself)", () => {
    expect(isPublicPath("/api/mcp")).toBe(true);
  });

  it("allows admin routes (x-migration-secret auth handled by the route itself)", () => {
    expect(isPublicPath("/api/admin/migrate")).toBe(true);
  });

  it("allows the public feedback/roadmap portal and its API", () => {
    expect(isPublicPath("/portal/rbcodelabs/compass/roadmap")).toBe(true);
    expect(isPublicPath("/api/portal/rbcodelabs/compass/feedback")).toBe(true);
  });

  it("allows token-authenticated participant research routes", () => {
    expect(isPublicPath("/research/opaque-participant-token")).toBe(true);
    expect(isPublicPath("/api/research/start")).toBe(true);
    expect(isPublicPath("/api/research/respond")).toBe(true);
    expect(isPublicPath("/api/research/complete")).toBe(true);
  });

  it("allows docs API routes (session auth handled internally)", () => {
    expect(isPublicPath("/api/docs/some-doc-id")).toBe(true);
  });

  it("allows PM interview API routes (session auth handled internally)", () => {
    expect(isPublicPath("/api/pm-interviews")).toBe(true);
    expect(isPublicPath("/api/pm-interviews/interview-id/complete")).toBe(true);
  });

  it("allows the public product docs", () => {
    expect(isPublicPath("/help")).toBe(true);
    expect(isPublicPath("/help/02-discovery")).toBe(true);
  });

  it("allows screenshots embedded in the public product docs", () => {
    expect(isPublicPath("/screenshots/docs/discovery-board.png")).toBe(true);
    expect(isPublicPath("/screenshots/docs/roadmap.png")).toBe(true);
  });

  it("allows the ADR-0009 preview-login page and its start route (both fail closed internally)", () => {
    expect(isPublicPath("/preview-login")).toBe(true);
    expect(isPublicPath("/api/preview-login/start")).toBe(true);
    expect(isPublicPath("/preview-login/extra")).toBe(false);
    expect(isPublicPath("/api/preview-login/other")).toBe(false);
  });

  it("does not allow authenticated app routes", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/rbcodelabs/compass/discovery")).toBe(false);
    expect(isPublicPath("/rbcodelabs/compass/settings")).toBe(false);
  });

  it("does not allow non-portal, non-admin API routes", () => {
    expect(isPublicPath("/api/branding/logo")).toBe(false);
  });

  it("allows the OAuth discovery documents", () => {
    // An MCP client fetches these before any user exists; a 302 to /login would
    // make Compass look like it has no authorization server at all.
    expect(isPublicPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isPublicPath("/.well-known/oauth-protected-resource/api/mcp")).toBe(true);
    expect(isPublicPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isPublicPath("/.well-known/openid-configuration")).toBe(true);
  });

  it("allows the OAuth machine-to-machine endpoints, which authenticate the client themselves", () => {
    expect(isPublicPath("/api/oauth/token")).toBe(true);
    expect(isPublicPath("/api/oauth/register")).toBe(true);
    expect(isPublicPath("/api/oauth/revoke")).toBe(true);
  });

  it("does NOT allow the authorize endpoint or the consent submission", () => {
    // Both must hit the middleware auth redirect: /oauth/authorize's first
    // question is "who is this?", and losing the session there would mean
    // issuing a token bound to nobody. proxy.ts preserves the query string,
    // which is where the entire authorization request lives.
    expect(isPublicPath("/oauth/authorize")).toBe(false);
    expect(isPublicPath("/oauth/consent")).toBe(false);
  });

  it("does not let the OAuth allowance widen to neighbouring paths", () => {
    expect(isPublicPath("/api/oauth")).toBe(false);
    expect(isPublicPath("/api/oauth/token/extra")).toBe(false);
    expect(isPublicPath("/api/oauth/introspect")).toBe(false);
    expect(isPublicPath("/well-known/oauth-authorization-server")).toBe(false);
  });

  it("allows only the exact bearer-authenticated voice callback family", () => {
    const base = "/api/internal/research/voice/00000000-0000-4000-8000-000000000001"
    for (const suffix of ["heartbeat", "events", "commands/claim", "commands/result"]) expect(isPublicPath(`${base}/${suffix}`)).toBe(true)
    for (const path of ["/api/internal/other", `${base}/ready`, `${base}/events/extra`, "/api/internal/research/voice/not-a-uuid/events"]) expect(isPublicPath(path)).toBe(false)
  });

  it("allows the outbound MCP connector gateway, which the sandbox calls with an AGENT_TURN bearer", () => {
    expect(isPublicPath("/api/integrations/mcp/v0")).toBe(true);
    expect(isPublicPath("/api/integrations/mcp/some-provider")).toBe(true);
  });

  it("does not let the gateway allowance widen to neighbouring integrations paths", () => {
    // The allowance is one slug-shaped segment, not a prefix: a future
    // /api/integrations/* route must opt in deliberately rather than inherit
    // public access from this one.
    expect(isPublicPath("/api/integrations")).toBe(false);
    expect(isPublicPath("/api/integrations/mcp")).toBe(false);
    expect(isPublicPath("/api/integrations/mcp/v0/extra")).toBe(false);
    expect(isPublicPath("/api/integrations/slack/v0")).toBe(false);
    // Traversal- and case-shaped attempts must not match the slug pattern.
    expect(isPublicPath("/api/integrations/mcp/..")).toBe(false);
    expect(isPublicPath("/api/integrations/mcp/V0")).toBe(false);
  });

  it("does NOT allow the browser connect/callback flow", () => {
    // Opposite requirement to the gateway: these need the middleware login
    // redirect so an anonymous visitor following a connect link is signed in and
    // returned with the query string intact, exactly like /oauth/authorize.
    expect(isPublicPath("/api/connectors")).toBe(false);
    expect(isPublicPath("/api/connectors/v0/connect")).toBe(false);
    expect(isPublicPath("/api/connectors/v0/callback")).toBe(false);
  });
});
