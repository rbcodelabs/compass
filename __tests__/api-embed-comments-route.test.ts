/**
 * Unit tests for app/api/embed/comments/route.ts.
 *
 * Prisma and lib/comments' createComment are mocked, following the same
 * "mock @/lib/db" pattern as __tests__/api-portal-feedback-route.test.ts. Token
 * resolution and the rate limiter are stubbed so each check can be exercised in
 * isolation — but `isOriginAllowed` and `EmbedSourceError` are the real
 * implementations, because the ordering of the origin check relative to
 * everything else is part of what is under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspace = { findUnique: vi.fn() };
const mockComment = { findMany: vi.fn() };

const mockPrisma = { workspace: mockWorkspace, comment: mockComment };

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));

vi.mock("@/lib/comments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/comments")>();
  return { ...actual, createComment: vi.fn() };
});

vi.mock("@/lib/embed-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embed-sources")>();
  return {
    ...actual,
    resolveEmbedToken: vi.fn(),
    consumeEmbedRate: vi.fn(),
    touchEmbedToken: vi.fn(),
  };
});

import { createComment } from "@/lib/comments";
import { EMBED_TOKEN_PREFIX, EmbedSourceError, consumeEmbedRate, resolveEmbedToken, touchEmbedToken } from "@/lib/embed-sources";
import { GET, OPTIONS, POST } from "@/app/api/embed/comments/route";

const mockCreateComment = vi.mocked(createComment);
const mockResolve = vi.mocked(resolveEmbedToken);
const mockRate = vi.mocked(consumeEmbedRate);

const ORIGIN = "https://prototype.example.com";
// Built from the exported prefix rather than pasted as one literal — the same
// shape __tests__/embed-sources.test.ts uses. A 32-hex literal here reads as a
// credential to the secret scanner, and it is not one: `resolveEmbedToken` is
// mocked in this file, so nothing ever hashes or looks this up.
const TOKEN = `${EMBED_TOKEN_PREFIX}${"0011223344556677".repeat(2)}`;

const RESOLVED = {
  tokenId: "token-1",
  sourceId: "source-1",
  workspaceId: "ws-1",
  artifactId: "artifact-1",
  allowedOrigins: [ORIGIN],
};

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN }) {
  return new NextRequest("http://localhost/api/embed/comments", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function get(query = "", headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN }) {
  return new NextRequest(`http://localhost/api/embed/comments${query}`, { headers });
}

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "comment-1",
    parentId: null,
    body: "The CTA is below the fold",
    status: "OPEN",
    authorName: "Dana",
    source: "WIDGET",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    elementAnchor: {
      pageUrl: `${ORIGIN}/pricing`,
      pagePath: "/pricing",
      elementSelector: "main > button.cta",
      elementFingerprint: { tag: "BUTTON", text: "Start free" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockResolvedValue({ ...RESOLVED });
  mockRate.mockResolvedValue(undefined);
  vi.mocked(touchEmbedToken).mockResolvedValue(undefined);
  mockCreateComment.mockResolvedValue({
    id: "comment-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  } as unknown as Awaited<ReturnType<typeof createComment>>);
});

describe("OPTIONS /api/embed/comments", () => {
  it("answers the preflight without requiring a token", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
  });

  it("never allows credentials, so no Compass session cookie can ride along", async () => {
    // The wildcard Allow-Origin above is only safe because of this. Checked on a
    // real response, not just on the header constant.
    for (const response of [await OPTIONS(), await POST(post({ body: "hi" }, { origin: ORIGIN }))]) {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });
});

describe("POST /api/embed/comments — credential and origin checks", () => {
  it("401s a request with no embed token, as JSON rather than a redirect", async () => {
    const response = await POST(post({ body: "hi" }, { origin: ORIGIN }));
    expect(response.status).toBe(401);
    // A 3xx here would be unreadable to a cross-site fetch.
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("401s a bearer token that is not an embed token", async () => {
    const response = await POST(post({ body: "hi" }, { authorization: "Bearer cmp_live_notanembedtoken", origin: ORIGIN }));
    expect(response.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("403s an origin that is not on the source's allowlist, before the rate limiter or the body", async () => {
    const response = await POST(post({ body: "hi" }, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.test" }));
    expect(response.status).toBe(403);
    expect(mockRate).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("403s a request with no Origin at all, so a curl caller is not exempt", async () => {
    const response = await POST(post({ body: "hi" }, { authorization: `Bearer ${TOKEN}` }));
    expect(response.status).toBe(403);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("surfaces the 501 for an unbound source rather than guessing a destination", async () => {
    mockResolve.mockRejectedValue(new EmbedSourceError(501, "This feedback source is not bound to an artifact."));
    const response = await POST(post({ body: "hi" }));
    expect(response.status).toBe(501);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("rate limits before parsing the body, and answers 429 with Retry-After", async () => {
    mockRate.mockRejectedValue(new EmbedSourceError(429, "Too many requests. Please wait and try again."));
    const request = post({ body: "hi", pageUrl: `${ORIGIN}/p`, pagePath: "/p" });
    const response = await POST(request);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    // An unauthenticated writer must not be able to make the server buffer and
    // parse a body it has already decided to refuse.
    expect(request.bodyUsed).toBe(false);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });
});

describe("POST /api/embed/comments — submission", () => {
  it("creates a WIDGET comment on the source's own artifact with an element anchor", async () => {
    const response = await POST(
      post({
        body: "  The CTA is below the fold  ",
        pageUrl: `${ORIGIN}/pricing`,
        pagePath: "/pricing",
        elementSelector: "main > button.cta",
        elementFingerprint: { tag: "BUTTON", text: "Start free", rectYRatio: 0.82, bogus: "dropped" },
        submitterName: "Dana",
        submitterEmail: "dana@example.com",
      })
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      comment: { id: "comment-1", createdAt: "2026-01-01T00:00:00.000Z" },
    });

    const input = mockCreateComment.mock.calls[0][0];
    expect(input.workspaceId).toBe("ws-1");
    expect(input.targetType).toBe("ARTIFACT");
    expect(input.targetId).toBe("artifact-1");
    expect(input.source).toBe("WIDGET");
    // The submitter is not a Compass User; their identity lives on the extension row.
    expect(input.authorId).toBeNull();
    expect(input.authorName).toBe("Dana");
    expect(input.externalAuthor).toEqual({ submitterEmail: "dana@example.com", embedTokenId: "token-1" });
    expect(input.elementAnchor).toEqual({
      pageUrl: `${ORIGIN}/pricing`,
      pagePath: "/pricing",
      elementSelector: "main > button.cta",
      elementFingerprint: {
        tag: "BUTTON",
        text: "Start free",
        rectXRatio: undefined,
        rectYRatio: 0.82,
        rectWRatio: undefined,
        rectHRatio: undefined,
      },
      artifactRevisionId: null,
    });
    // The fingerprint is rebuilt field by field, so the JSON column cannot be
    // used by an embedding page as arbitrary storage.
    expect(input.elementAnchor?.elementFingerprint).not.toHaveProperty("bogus");
  });

  it("ignores a caller-supplied target: the binding comes from the stored source row", async () => {
    await POST(
      post({
        body: "hi",
        pageUrl: `${ORIGIN}/p`,
        pagePath: "/p",
        // A hostile widget trying to file against someone else's artifact.
        targetId: "artifact-of-another-workspace",
        artifactId: "artifact-of-another-workspace",
        workspaceId: "ws-2",
        authorId: "user-1",
      })
    );
    const input = mockCreateComment.mock.calls[0][0];
    expect(input.targetId).toBe("artifact-1");
    expect(input.workspaceId).toBe("ws-1");
    expect(input.authorId).toBeNull();
  });

  it("falls back to the email, then to Anonymous, for the display name", async () => {
    await POST(post({ body: "hi", pageUrl: `${ORIGIN}/p`, pagePath: "/p", submitterEmail: "dana@example.com" }));
    expect(mockCreateComment.mock.calls[0][0].authorName).toBe("dana@example.com");

    mockCreateComment.mockClear();
    await POST(post({ body: "hi", pageUrl: `${ORIGIN}/p`, pagePath: "/p" }));
    expect(mockCreateComment.mock.calls[0][0].authorName).toBe("Anonymous");
  });

  it("drops an unparseable email rather than storing it", async () => {
    await POST(post({ body: "hi", pageUrl: `${ORIGIN}/p`, pagePath: "/p", submitterEmail: "not an email" }));
    const input = mockCreateComment.mock.calls[0][0];
    expect(input.externalAuthor?.submitterEmail).toBeNull();
    expect(input.authorName).toBe("Anonymous");
  });

  it("sends no anchor on a reply, which inherits its parent's", async () => {
    await POST(post({ body: "thanks!", parentId: "comment-1", pageUrl: `${ORIGIN}/p`, pagePath: "/p" }));
    const input = mockCreateComment.mock.calls[0][0];
    expect(input.parentId).toBe("comment-1");
    expect(input.elementAnchor).toBeUndefined();
    // An external author is still recorded — an outside submitter answering on
    // their own thread is the normal case.
    expect(input.externalAuthor).toEqual({ submitterEmail: null, embedTokenId: "token-1" });
  });

  it("400s a root submission with no page identity", async () => {
    const response = await POST(post({ body: "hi" }));
    expect(response.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("400s an empty or over-long body", async () => {
    expect((await POST(post({ body: "   ", pageUrl: `${ORIGIN}/p`, pagePath: "/p" }))).status).toBe(400);
    expect((await POST(post({ body: "x".repeat(4001), pageUrl: `${ORIGIN}/p`, pagePath: "/p" }))).status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("400s a body over the 32 KB cap without buffering it all", async () => {
    const response = await POST(post("x".repeat(40 * 1024)));
    expect(response.status).toBe(400);
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it("400s a non-object JSON body", async () => {
    expect((await POST(post("[1,2,3]"))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
  });

  it("reports a createComment invariant as a 400, not a 500", async () => {
    mockCreateComment.mockRejectedValue(new Error("ARTIFACT target not found or not commentable."));
    const response = await POST(post({ body: "hi", pageUrl: `${ORIGIN}/p`, pagePath: "/p" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "ARTIFACT target not found or not commentable." });
  });

  it("lets a genuine fault through rather than blaming the caller", async () => {
    // A TypeError is a bug in Compass, not a malformed request.
    mockCreateComment.mockRejectedValue(new TypeError("cannot read properties of undefined"));
    await expect(POST(post({ body: "hi", pageUrl: `${ORIGIN}/p`, pagePath: "/p" }))).rejects.toBeInstanceOf(TypeError);
  });
});

describe("GET /api/embed/comments", () => {
  it("403s when the workspace has not published artifact feedback", async () => {
    mockWorkspace.findUnique.mockResolvedValue({ artifactFeedbackPublic: false });
    const response = await GET(get());
    expect(response.status).toBe(403);
    expect(mockComment.findMany).not.toHaveBeenCalled();
  });

  it("403s when the workspace row is missing entirely", async () => {
    mockWorkspace.findUnique.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(403);
  });

  it("401s before consulting the workspace flag when there is no token", async () => {
    const response = await GET(get("", { origin: ORIGIN }));
    expect(response.status).toBe(401);
    expect(mockWorkspace.findUnique).not.toHaveBeenCalled();
  });

  it("returns anchored root comments with their replies nested", async () => {
    mockWorkspace.findUnique.mockResolvedValue({ artifactFeedbackPublic: true });
    mockComment.findMany
      .mockResolvedValueOnce([commentRow()])
      .mockResolvedValueOnce([
        commentRow({
          id: "reply-1",
          parentId: "comment-1",
          body: "Fixed in the next build",
          authorName: "Compass user",
          source: "UI",
          elementAnchor: null,
          updatedAt: new Date("2026-01-02T00:00:00Z"),
        }),
      ]);

    const response = await GET(get("?pagePath=/pricing"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response.json();

    expect(payload.artifactId).toBe("artifact-1");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({
      id: "comment-1",
      body: "The CTA is below the fold",
      authorName: "Dana",
      source: "WIDGET",
      edited: false,
      anchor: { pagePath: "/pricing", elementSelector: "main > button.cta" },
    });
    expect(payload.comments[0].replies).toHaveLength(1);
    expect(payload.comments[0].replies[0]).toMatchObject({ id: "reply-1", edited: true, anchor: null });
  });

  it("exposes nothing that identifies the submitter beyond their display name", async () => {
    mockWorkspace.findUnique.mockResolvedValue({ artifactFeedbackPublic: true });
    mockComment.findMany.mockResolvedValueOnce([commentRow()]).mockResolvedValueOnce([]);
    const payload = await (await GET(get())).json();
    const serialized = JSON.stringify(payload);
    for (const leak of ["authorId", "submitterEmail", "embedTokenId", "workspaceId", "portalAccountId"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("filters by pagePath when given one, and to anchored comments when not", async () => {
    mockWorkspace.findUnique.mockResolvedValue({ artifactFeedbackPublic: true });
    mockComment.findMany.mockResolvedValue([]);

    await GET(get("?pagePath=/pricing"));
    expect(mockComment.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: "ws-1",
      targetType: "ARTIFACT",
      targetId: "artifact-1",
      elementAnchor: { is: { pagePath: "/pricing" } },
    });

    mockComment.findMany.mockClear();
    await GET(get());
    // Unanchored internal review comments are excluded either way.
    expect(mockComment.findMany.mock.calls[0][0].where.elementAnchor).toEqual({ isNot: null });
  });

  it("skips the reply query when nothing matched", async () => {
    mockWorkspace.findUnique.mockResolvedValue({ artifactFeedbackPublic: true });
    mockComment.findMany.mockResolvedValueOnce([]);
    const payload = await (await GET(get())).json();
    expect(payload.comments).toEqual([]);
    expect(mockComment.findMany).toHaveBeenCalledTimes(1);
  });

  it("draws reads from a separate quota than submissions", async () => {
    mockWorkspace.findUnique.mockResolvedValue({ artifactFeedbackPublic: true });
    mockComment.findMany.mockResolvedValue([]);
    await GET(get());
    expect(mockRate).toHaveBeenCalledWith("token-1", "READ");
  });
});
