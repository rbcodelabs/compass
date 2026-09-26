/**
 * Unit tests for app/api/embed/session/route.ts — the widget's check and
 * sign-out endpoint.
 *
 * This route used to have a third method, POST, that exchanged a handoff nonce
 * for a minted visitor token — reachable by any HTTP client presenting just the
 * nonce and the (public) embed token. That was the account-takeover vulnerability
 * fixed by moving the mint into `depositEmbedSignIn`
 * (app/embed/signin/actions.ts), a same-origin, cookie-authenticated server
 * action; see __tests__/embed-signin-action.test.ts for that half. The route no
 * longer exports POST at all, which the "no longer claimable here" describe block
 * below is the regression test for.
 *
 * Same mocking shape as __tests__/api-embed-comments-route.test.ts: the embed
 * token resolver, the rate limiter, and the visitor-session library are stubbed,
 * while `isOriginAllowed` and `EmbedSourceError` stay real because the ordering of
 * the origin check relative to everything else is part of what is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return { ...actual, resolveEmbedToken: vi.fn(), consumeEmbedRate: vi.fn(), touchEmbedToken: vi.fn() };
});

vi.mock("@/lib/embed-visitor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-visitor")>();
  return {
    ...actual,
    resolveEmbedVisitorToken: vi.fn(),
    revokeEmbedVisitorToken: vi.fn(),
  };
});

import { EMBED_TOKEN_PREFIX, EmbedSourceError, consumeEmbedRate, resolveEmbedToken } from "@/lib/embed-sources";
import { EMBED_VISITOR_HEADER } from "@/lib/embed/http";
import { EMBED_VISITOR_TOKEN_PREFIX, resolveEmbedVisitorToken, revokeEmbedVisitorToken } from "@/lib/embed-visitor";
import * as sessionRoute from "@/app/api/embed/session/route";
import { DELETE, GET, OPTIONS } from "@/app/api/embed/session/route";

const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);
const mockResolveVisitor = vi.mocked(resolveEmbedVisitorToken);
const mockRevoke = vi.mocked(revokeEmbedVisitorToken);

const ORIGIN = "https://prototype.example.com";
// Assembled from the exported prefix rather than pasted whole: resolveEmbedToken
// is mocked here so nothing hashes or looks this up, and a bare 32-hex literal
// would read to the secret scanner as a credential it is not.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;
const VISITOR_TOKEN = `${EMBED_VISITOR_TOKEN_PREFIX}${"89abcdef89abcdef".repeat(2)}`;

const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: [ORIGIN],
  authMode: "PORTAL" as const,
};

const IDENTITY = {
  kind: "PORTAL" as const,
  portalAccountId: "portal-1",
  email: "dana@example.com",
  name: "Dana",
};

/**
 * The internal arm of the same union. This route reads only `email` and `name`,
 * which both arms carry, so it needed no code change — the test below is what
 * holds that true rather than leaving it to be rediscovered.
 */
const INTERNAL_IDENTITY = {
  kind: "INTERNAL" as const,
  userId: "user-1",
  email: "pat@bankrate.com",
  name: "Pat",
};
const AUTH = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN };

function get(headers: Record<string, string> = AUTH) {
  return new NextRequest("http://localhost/api/embed/session", { headers });
}

function del(headers: Record<string, string> = AUTH) {
  return new NextRequest("http://localhost/api/embed/session", { method: "DELETE", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockRate.mockResolvedValue(undefined);
  mockResolveVisitor.mockResolvedValue({ ...IDENTITY });
  mockRevoke.mockResolvedValue(undefined);
});

describe("OPTIONS", () => {
  it("advertises exactly the two remaining methods so a browser preflight succeeds", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    // POST is gone — see the module header. A preflight advertising it would
    // invite a browser to send a request this route no longer handles.
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, DELETE, OPTIONS");
    // Without the visitor header listed, the preflight for a signed-in GET fails
    // before the request is ever sent.
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(EMBED_VISITOR_HEADER);
  });
});

/**
 * The regression test for the vulnerability itself: a non-browser-style direct
 * call presenting only a valid nonce and embed token — the exact shape a curl
 * script driving the old POST used — must not yield a token, because there is no
 * longer any handler here to present it to.
 */
describe("no longer claimable here", () => {
  it("exports no POST handler at all", () => {
    expect((sessionRoute as Record<string, unknown>).POST).toBeUndefined();
  });

  it("the exported handlers are exactly GET, DELETE, and OPTIONS", () => {
    const exported = Object.keys(sessionRoute).sort();
    expect(exported).toEqual(["DELETE", "GET", "OPTIONS"]);
  });
});

describe("shared authorization", () => {
  it("rejects a request with no embed token on every method", async () => {
    for (const request of [get({ origin: ORIGIN }), del({ origin: ORIGIN })]) {
      const handler = request.method === "GET" ? GET : DELETE;
      const response = await handler(request);
      expect(response.status).toBe(401);
      // Nothing downstream runs: no quota charged, no revoke.
      expect(mockRate).not.toHaveBeenCalled();
      expect(mockRevoke).not.toHaveBeenCalled();
    }
  });

  it("rejects a disallowed origin on every method, before any work", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example.com" };
    for (const [handler, request] of [
      [GET, get(headers)],
      [DELETE, del(headers)],
    ] as const) {
      const response = await handler(request);
      expect(response.status).toBe(403);
      expect(mockRevoke).not.toHaveBeenCalled();
    }
  });

  it("surfaces a revoked or disabled source as the resolver's own status", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(403, "Feedback source is disabled"));
    const response = await GET(get());
    expect(response.status).toBe(403);
  });

  it("returns 429 with Retry-After when the quota is spent", async () => {
    mockRate.mockRejectedValue(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    const response = await GET(get());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("never sets Access-Control-Allow-Credentials, so no cookie can ride along", async () => {
    const response = await GET(get());
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // A minted credential must never be cached by a shared proxy.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET — checking a stored visitor token", () => {
  it("names the account a live token belongs to", async () => {
    const response = await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: true, email: "dana@example.com", name: "Dana" });
    expect(mockResolveVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("names an internal member the same way, and still says nothing about their user id", async () => {
    // This route is identity-kind agnostic on purpose: it reports the email and
    // name a human recognizes, and the widget has no use for either internal
    // identifier. A response naming a Compass user id would put it in reach of
    // every script on the embedding page.
    mockResolveVisitor.mockResolvedValue({ ...INTERNAL_IDENTITY });
    const response = await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ signedIn: true, email: "pat@bankrate.com", name: "Pat" });
    expect(body).not.toContain("user-1");
  });

  it("answers signedIn:false with a 200 when there is no token at all", async () => {
    const response = await GET(get());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
    // Not merely "returns false": asking with no token must not cost a lookup.
    expect(mockResolveVisitor).not.toHaveBeenCalled();
  });

  it("answers signedIn:false rather than 401 for a dead token", async () => {
    // Expired, revoked from another tab, or minted for a different source — all
    // one answer, because a widget would otherwise treat "not signed in yet" as
    // an error state and show the visitor a failure they did not cause.
    mockResolveVisitor.mockResolvedValue(null);
    const response = await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
  });

  it("accepts the visitor token with or without a Bearer prefix", async () => {
    await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: `Bearer ${VISITOR_TOKEN}` }));
    // The widget holds two bearer-ish credentials; shaping this one like the
    // other is the obvious slip, and it is not worth a failed sign-in.
    expect(mockResolveVisitor).toHaveBeenCalledWith(VISITOR_TOKEN, "source-1");
  });

  it("treats a whitespace-only header as absent", async () => {
    await GET(get({ ...AUTH, [EMBED_VISITOR_HEADER]: "   " }));
    expect(mockResolveVisitor).not.toHaveBeenCalled();
  });
});

describe("DELETE — signing out of the widget", () => {
  it("revokes the presented token and reports the signed-out state", async () => {
    const response = await DELETE(del({ ...AUTH, [EMBED_VISITOR_HEADER]: VISITOR_TOKEN }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
    expect(mockRevoke).toHaveBeenCalledWith(VISITOR_TOKEN);
  });

  it("succeeds with nothing to revoke, and says nothing about whether there was", async () => {
    const response = await DELETE(del());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ signedIn: false });
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("keeps a token of the wrong shape off the database", async () => {
    await DELETE(del({ ...AUTH, [EMBED_VISITOR_HEADER]: "not-a-visitor-token" }));
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
