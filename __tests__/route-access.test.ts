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

  it("allows the public product docs", () => {
    expect(isPublicPath("/help")).toBe(true);
    expect(isPublicPath("/help/02-discovery")).toBe(true);
  });

  it("allows screenshots embedded in the public product docs", () => {
    expect(isPublicPath("/screenshots/docs/discovery-board.png")).toBe(true);
    expect(isPublicPath("/screenshots/docs/roadmap.png")).toBe(true);
  });

  it("does not allow authenticated app routes", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/rbcodelabs/compass/discovery")).toBe(false);
    expect(isPublicPath("/rbcodelabs/compass/settings")).toBe(false);
  });

  it("does not allow non-portal, non-admin API routes", () => {
    expect(isPublicPath("/api/branding/logo")).toBe(false);
  });

  it("allows only the exact bearer-authenticated voice callback family", () => {
    const base = "/api/internal/research/voice/00000000-0000-4000-8000-000000000001"
    for (const suffix of ["heartbeat", "events", "commands/claim", "commands/result"]) expect(isPublicPath(`${base}/${suffix}`)).toBe(true)
    for (const path of ["/api/internal/other", `${base}/ready`, `${base}/events/extra`, "/api/internal/research/voice/not-a-uuid/events"]) expect(isPublicPath(path)).toBe(false)
  });
});
