import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getWorkspace: vi.fn(),
  docFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.getWorkspace }));
vi.mock("@/lib/card-sort", () => ({ CardSortError: class extends Error {}, loadCardSortBoard: vi.fn() }));
vi.mock("@/lib/card-sort-new-entries", () => ({ listCardSortNewEntries: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: () => ({
    doc: { findFirst: mocks.docFindFirst, findMany: vi.fn().mockResolvedValue([]) },
    docComment: { findMany: mocks.commentFindMany },
    artifact: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

import { GET } from "@/app/api/live/change-token/route";

const ID = "3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";
const get = (scope: string) =>
  GET(new Request(`http://localhost/api/live/change-token?orgSlug=acme&workspaceSlug=main&scope=${encodeURIComponent(scope)}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "u1" } });
  mocks.getWorkspace.mockResolvedValue({ id: "ws-1" });
  mocks.docFindFirst.mockResolvedValue({ id: ID, revision: null, updatedAt: new Date(0), docType: "STANDARD", title: "T" });
  mocks.commentFindMany.mockResolvedValue([]);
});

describe("GET /api/live/change-token entity scopes", () => {
  it("rejects anonymous callers", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await get(`doc:${ID}`)).status).toBe(401);
  });

  it("404s when the caller cannot read the workspace, without touching the entity", async () => {
    mocks.getWorkspace.mockResolvedValue(null);
    expect((await get(`doc:${ID}`)).status).toBe(404);
    expect(mocks.docFindFirst).not.toHaveBeenCalled();
  });

  it("returns a token for a doc in the workspace", async () => {
    const res = await get(`doc:${ID}`);
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).token).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s for an entity from another workspace, with no token", async () => {
    mocks.docFindFirst.mockResolvedValue(null);
    const res = await get(`doc:${ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("404s for a missing artifact", async () => {
    expect((await get(`artifact:${ID}`)).status).toBe(404);
  });

  it("serves docs-tree and rejects malformed entity scopes with 400", async () => {
    expect((await get("docs-tree")).status).toBe(200);
    expect((await get("doc:nope")).status).toBe(400);
    expect((await get("bogus")).status).toBe(400);
  });
});
