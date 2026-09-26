/**
 * Unit tests for app/embed/signin/actions.ts — the step in the widget's sign-in
 * handoff that reads an identity, either the portal session cookie or the Compass
 * SSO session, and — as of the fix this file also covers — mints and returns the
 * widget's visitor credential in the same call.
 *
 * The policy under test: a bad credential is refused before any identity is
 * consulted, an unsigned-in visitor gets a retryable answer rather than an error,
 * the deposit is scoped to the source the *token* named rather than anything the
 * caller passed, polling does not exhaust the write quota, an unrecognized origin
 * is refused before any write, no credential leaks to a caller who should not have
 * it (a `not_authorized` or `signin_required` result stays credential-free), and —
 * for an internal source — merely being signed into Compass is not enough.
 *
 * ## Why deposit and claim are tested together here
 *
 * Before the fix, `depositEmbedSignIn` only deposited a handoff row; a separate,
 * publicly reachable route (`POST /api/embed/session`, see
 * __tests__/api-embed-session-route.test.ts) claimed it for any caller presenting
 * the nonce — including a non-browser client, since a nonce is chosen by whoever
 * builds the popup URL and nothing enforced that this was the same widget. That
 * route's POST handler no longer exists at all, so the vulnerability's other half
 * — "a direct call presenting only a valid nonce/token must not yield a token" —
 * is covered by the fact that there is nothing left there to present it to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/lib/portal-auth", () => ({ getPortalSession: vi.fn() }));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/workspace", () => ({ isWorkspaceMember: vi.fn() }));

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return { ...actual, resolveEmbedToken: vi.fn(), consumeEmbedRate: vi.fn() };
});

vi.mock("@/lib/embed-visitor", () => ({ depositEmbedAuthHandoff: vi.fn(), claimEmbedAuthHandoff: vi.fn() }));

import { getPortalSession } from "@/lib/portal-auth";
import { auth } from "@/auth";
import { isWorkspaceMember } from "@/lib/workspace";
import { EMBED_TOKEN_PREFIX, EmbedSourceError, consumeEmbedRate, resolveEmbedToken } from "@/lib/embed-sources";
import { claimEmbedAuthHandoff, depositEmbedAuthHandoff } from "@/lib/embed-visitor";
import { depositEmbedSignIn } from "@/app/embed/signin/actions";

const mockSession = vi.mocked(getPortalSession);
// `auth` is NextAuth's overloaded export: a session reader, a route-handler
// wrapper, and a middleware wrapper all under one name. vi.mocked() resolves to
// the last of those, so an unannotated mock wants a NextMiddleware rather than a
// session. Only the zero-argument reader overload is called from the code under
// test, so the mock is narrowed to that signature here.
const mockAuth = vi.mocked(auth as () => Promise<Session | null>);
const mockIsMember = vi.mocked(isWorkspaceMember);
const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);
const mockDeposit = vi.mocked(depositEmbedAuthHandoff);
const mockClaim = vi.mocked(claimEmbedAuthHandoff);

// Built from the exported prefix rather than pasted whole, same as
// __tests__/api-embed-comments-route.test.ts: resolveEmbedToken is mocked here, so
// nothing hashes or looks this up and a bare hex literal would read to the secret
// scanner as a credential it is not.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;
const NONCE = "a".repeat(64);
const WIDGET_ORIGIN = "https://prototype.example.com";
const VISITOR_TOKEN = "cmpvt_" + "89abcdef89abcdef".repeat(2);
const EXPIRES = new Date("2026-01-01T12:00:00Z");

// PORTAL throughout this block: the portal path is the pre-existing behavior, and
// these tests are here to hold it unchanged now that a second mode exists. The
// INTERNAL_SSO block further down overrides the mode explicitly.
const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: [WIDGET_ORIGIN],
  authMode: "PORTAL" as const,
};

const IDENTITY = { portalAccountId: "portal-1", email: "dana@example.com", name: "Dana" };

// `expires` is required on Session and is carried here for that reason alone —
// nothing in this action reads it. Expiry is enforced by NextAuth before auth()
// returns a session at all, so a live session is the only thing under test.
const SSO_SESSION = {
  user: { id: "user-1", email: "pat@example.com", name: "Pat" },
  expires: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockRate.mockResolvedValue(undefined);
  mockSession.mockResolvedValue({ ...IDENTITY });
  mockDeposit.mockResolvedValue(undefined);
  mockClaim.mockResolvedValue({ token: VISITOR_TOKEN, expiresAt: EXPIRES });
  // Defaults for the internal path: signed in and a member. Each test below
  // narrows whichever half it is about.
  mockAuth.mockResolvedValue({ ...SSO_SESSION });
  mockIsMember.mockResolvedValue(true);
});

describe("depositEmbedSignIn", () => {
  it("deposits a handoff scoped to the source the token resolved to, then claims it in the same call", async () => {
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "deposited",
      email: "dana@example.com",
      token: VISITOR_TOKEN,
      expiresAt: EXPIRES.toISOString(),
      origin: WIDGET_ORIGIN,
    });

    expect(mockDeposit).toHaveBeenCalledWith({
      nonce: NONCE,
      // From the resolved token, never from a caller-supplied parameter — this
      // action is reachable by anyone who can open the popup.
      feedbackSourceId: "source-1",
      // From the portal session cookie, never from the request.
      identity: { portalAccountId: "portal-1" },
    });
    // The claim happens right here, atomically, rather than being left for a
    // second call the widget makes on its own — see the module header.
    expect(mockClaim).toHaveBeenCalledWith({ nonce: NONCE, feedbackSourceId: "source-1" });
    // A PORTAL source does not consult the Compass session at all: a member of
    // this workspace who happens to be signed in must still be filed as the
    // external reviewer the source is configured for.
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockIsMember).not.toHaveBeenCalled();
  });

  it("carries the visitor token and nothing else claimable beyond it", async () => {
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    const serialized = JSON.stringify(result);
    // The token is now expected here — it travels back only as far as the popup's
    // own render, and onward from there solely via postMessage. What must still
    // never appear is the nonce (single-use; leaking it would let it be replayed
    // through a different channel) or the internal portal account id.
    expect(serialized).toContain(VISITOR_TOKEN);
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain("portal-1");
    expect(result).toEqual({
      status: "deposited",
      email: "dana@example.com",
      token: VISITOR_TOKEN,
      expiresAt: EXPIRES.toISOString(),
      origin: WIDGET_ORIGIN,
    });
  });

  it("asks the visitor to sign in rather than failing, and writes nothing", async () => {
    mockSession.mockResolvedValue(null);
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      // The mode travels with the refusal because the popup renders a different
      // affordance for each — a magic-link form here, an SSO link for internal.
      status: "signin_required",
      mode: "PORTAL",
    });
    expect(mockDeposit).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("refuses a bad credential before consulting any identity", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(401, "Invalid embed token"));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "unavailable",
      error: "Invalid embed token",
    });
    // Not merely "no deposit": a stranger must not be able to use this action to
    // learn whether the browser they are driving carries a portal session.
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("surfaces a disabled source and an unbound source as the visitor-facing refusal", async () => {
    for (const thrown of [
      new EmbedSourceError(403, "Feedback source is disabled"),
      new EmbedSourceError(501, "This feedback source is not bound to an artifact."),
    ]) {
      mockResolve.mockRejectedValue(thrown);
      await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
        status: "unavailable",
        error: thrown.message,
      });
    }
  });

  /**
   * The regression test for the vulnerability this fix closes: even a caller with
   * a fully valid, authenticated session and real workspace membership — not a bad
   * actor by any other measure — must be refused if the origin it names is not one
   * the operator put on this source's allowlist. This is what stops a target's own
   * legitimate session from being bound to a nonce someone else chose.
   */
  it("refuses an unrecognized origin before any deposit, even with a fully valid session and membership", async () => {
    await expect(
      depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: "https://attacker.example.com" })
    ).resolves.toEqual({
      status: "unavailable",
      error:
        "This sign-in cannot be completed from an unrecognized origin. Ask whoever embedded this prototype to add your origin to its allowed list.",
    });
    // Refused before the identity check, not after: a stranger must not be able to
    // use a mismatched origin to learn whether a portal session exists either.
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockDeposit).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("reports a malformed nonce as unavailable without leaking why", async () => {
    // The real gate is assertWellFormedNonce in lib/embed-visitor.ts, which throws
    // a message naming neither the nonce nor the mechanism.
    mockDeposit.mockRejectedValue(new EmbedSourceError(400, "Malformed sign-in request."));
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: "nope", origin: WIDGET_ORIGIN });
    expect(result).toEqual({ status: "unavailable", error: "Malformed sign-in request." });
  });

  it("charges the read quota on every call, including a signed-out poll", async () => {
    mockSession.mockResolvedValue(null);
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
    // The popup polls for minutes while the visitor reads their email. Charging
    // the 20/min submit quota per poll would lock them out of the flow they are
    // halfway through.
    expect(mockRate).not.toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("charges the write quota once a real deposit happens", async () => {
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
    expect(mockRate).toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("reports a tripped quota to the visitor instead of throwing", async () => {
    // Next redacts an uncaught server-action message in production, so throwing
    // here would reach the visitor as "An unexpected error occurred".
    mockRate.mockRejectedValue(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "unavailable",
      error: "Too many requests. Please wait and try again.",
    });
  });

  it("keeps the poll loop alive on a repeat deposit of the same nonce, rather than erroring", async () => {
    // Two overlapping polls, or a client remounted by React's development double
    // invoke. One widget instance owns the nonce, so this is the same popup
    // arriving twice rather than two parties racing for one slot. Deposit and
    // claim are now atomic, so the winning call has already deposited, claimed,
    // and deleted the row by the time this one's unique-constraint error surfaces
    // — there is nothing left here to re-read and report as "deposited" again.
    // `signin_required` is the non-terminal answer that keeps the popup's poll
    // loop going rather than presenting a dead end.
    mockDeposit.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "signin_required",
      mode: "PORTAL",
    });
    // Not consulted: there is no session to re-read on this path anymore.
    expect(mockSession).toHaveBeenCalledTimes(1);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("does not report an unexpected fault as the visitor's mistake", async () => {
    mockDeposit.mockRejectedValue(new TypeError("cannot read properties of undefined"));
    const result = await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    // Generic on purpose: a bug in Compass is not something the visitor can act
    // on, and its message is not theirs to read.
    expect(result).toEqual({ status: "unavailable", error: "Something went wrong. Please try again." });
  });
});

describe("depositEmbedSignIn — INTERNAL_SSO", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({ ...RESOLVED, authMode: "INTERNAL_SSO" });
  });

  it("deposits the Compass user behind the session, and no portal account, then claims it in the same call", async () => {
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "deposited",
      email: "pat@example.com",
      token: VISITOR_TOKEN,
      expiresAt: EXPIRES.toISOString(),
      origin: WIDGET_ORIGIN,
    });

    expect(mockDeposit).toHaveBeenCalledWith({
      nonce: NONCE,
      feedbackSourceId: "source-1",
      // The user id comes off the SSO session, never off the request, and the
      // handoff names exactly this one identity.
      identity: { userId: "user-1" },
    });
    expect(mockClaim).toHaveBeenCalledWith({ nonce: NONCE, feedbackSourceId: "source-1" });
    // The portal cookie is not consulted on this path at all.
    expect(mockSession).not.toHaveBeenCalled();
  });

  it("checks membership of the workspace that owns the source, not the source id", async () => {
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    // ws-1 is from the resolved token. A caller cannot nominate the workspace it
    // would like to be checked against.
    expect(mockIsMember).toHaveBeenCalledWith("ws-1", "user-1");
  });

  it("rejects an authenticated non-member, and writes nothing", async () => {
    // The whole point of "internal team only": being signed into Compass, on an
    // allowed email domain, is not authorization to write into this workspace.
    mockIsMember.mockResolvedValue(false);

    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "not_authorized",
      email: "pat@example.com",
    });
    expect(mockDeposit).not.toHaveBeenCalled();
    // Not signin_required either: signing in again cannot fix it, so the popup
    // must not offer a login button that would loop forever.
    expect(mockRate).not.toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("asks an unauthenticated visitor to sign in, naming the internal mode", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "signin_required",
      mode: "INTERNAL_SSO",
    });
    expect(mockDeposit).not.toHaveBeenCalled();
    // Membership is not consulted for someone with no identity yet.
    expect(mockIsMember).not.toHaveBeenCalled();
  });

  it("charges the read quota on a signed-out poll and the write quota only on deposit", async () => {
    mockAuth.mockResolvedValue(null);
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
    expect(mockRate).not.toHaveBeenCalledWith("token-1", "SUBMIT");

    mockAuth.mockResolvedValue({ ...SSO_SESSION });
    await depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN });
    expect(mockRate).toHaveBeenCalledWith("token-1", "SUBMIT");
  });

  it("refuses a bad credential before consulting the SSO session", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(401, "Invalid embed token"));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "unavailable",
      error: "Invalid embed token",
    });
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockIsMember).not.toHaveBeenCalled();
  });

  it("refuses an unrecognized origin before consulting the SSO session", async () => {
    await expect(
      depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: "https://attacker.example.com" })
    ).resolves.toEqual({
      status: "unavailable",
      error:
        "This sign-in cannot be completed from an unrecognized origin. Ask whoever embedded this prototype to add your origin to its allowed list.",
    });
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockIsMember).not.toHaveBeenCalled();
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("keeps the poll loop alive on a repeat deposit of the same nonce on this path too", async () => {
    mockDeposit.mockRejectedValue(Object.assign(new Error("unique constraint"), { code: "P2002" }));
    await expect(depositEmbedSignIn({ token: TOKEN, nonce: NONCE, origin: WIDGET_ORIGIN })).resolves.toEqual({
      status: "signin_required",
      mode: "INTERNAL_SSO",
    });
    expect(mockClaim).not.toHaveBeenCalled();
  });
});
