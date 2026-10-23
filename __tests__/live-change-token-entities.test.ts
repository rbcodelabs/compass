import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docFindMany: vi.fn(),
  commentFindMany: vi.fn(),
  artifactFindFirst: vi.fn(),
  artifactFindMany: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  default: () => ({
    doc: { findFirst: mocks.docFindFirst, findMany: mocks.docFindMany },
    docComment: { findMany: mocks.commentFindMany },
    artifact: { findFirst: mocks.artifactFindFirst, findMany: mocks.artifactFindMany },
  }),
}));
vi.mock("@/lib/card-sort", () => ({ loadCardSortBoard: vi.fn() }));
vi.mock("@/lib/card-sort-new-entries", () => ({ listCardSortNewEntries: vi.fn() }));

import { computeEntityChangeToken, parseEntityScope } from "@/lib/live-change-token";

const ID = "3f2b8c1e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";
const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-01-02T00:00:00Z");
const docRow = { id: ID, revision: null, updatedAt: T1, docType: "STANDARD", title: "Plan" };
const artifactRow = {
  id: ID, currentRevisionId: "r1", updatedAt: T1, status: "ACTIVE", title: "A", description: null, kind: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.docFindFirst.mockResolvedValue(docRow);
  mocks.commentFindMany.mockResolvedValue([]);
  mocks.artifactFindFirst.mockResolvedValue(artifactRow);
  mocks.docFindMany.mockResolvedValue([]);
  mocks.artifactFindMany.mockResolvedValue([]);
});

describe("parseEntityScope", () => {
  it("parses doc, artifact and docs-tree scopes", () => {
    expect(parseEntityScope(`doc:${ID}`)).toEqual({ kind: "doc", id: ID });
    expect(parseEntityScope(`artifact:${ID}`)).toEqual({ kind: "artifact", id: ID });
    expect(parseEntityScope("docs-tree")).toEqual({ kind: "docs-tree" });
  });

  it("rejects board scopes, malformed ids and null", () => {
    expect(parseEntityScope("tasks")).toBeNull();
    expect(parseEntityScope("doc:not-a-uuid")).toBeNull();
    expect(parseEntityScope("doc:")).toBeNull();
    expect(parseEntityScope(`folder:${ID}`)).toBeNull();
    expect(parseEntityScope(null)).toBeNull();
  });
});

describe("computeEntityChangeToken: doc", () => {
  it("scopes the lookup to the workspace and never selects content", async () => {
    await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    const args = mocks.docFindFirst.mock.calls[0][0];
    expect(args.where).toEqual({ id: ID, workspaceId: "ws-1" });
    expect(Object.keys(args.select).sort()).toEqual(["docType", "id", "revision", "title", "updatedAt"]);
    expect(args.select).not.toHaveProperty("content");
    expect(mocks.commentFindMany.mock.calls[0][0].select).not.toHaveProperty("body");
  });

  it("returns null for a doc in another workspace (no info leak)", async () => {
    mocks.docFindFirst.mockResolvedValue(null);
    expect(await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-other")).toBeNull();
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
  });

  it("changes with revision, and with updatedAt when revision is null (legacy rows)", async () => {
    const base = await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    mocks.docFindFirst.mockResolvedValue({ ...docRow, updatedAt: T2 });
    const touched = await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    mocks.docFindFirst.mockResolvedValue({ ...docRow, revision: "rev-1" });
    const revised = await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    expect(touched).not.toBe(base);
    expect(revised).not.toBe(base);
    mocks.docFindFirst.mockResolvedValue(docRow);
    expect(await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1")).toBe(base);
  });

  it("changes when a comment is added or resolved", async () => {
    const base = await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    mocks.commentFindMany.mockResolvedValue([{ id: "c1", status: "OPEN", updatedAt: T1 }]);
    const added = await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    mocks.commentFindMany.mockResolvedValue([{ id: "c1", status: "RESOLVED", updatedAt: T1 }]);
    const resolved = await computeEntityChangeToken({ kind: "doc", id: ID }, "ws-1");
    expect(new Set([base, added, resolved]).size).toBe(3);
  });
});

describe("computeEntityChangeToken: artifact", () => {
  it("scopes to the workspace and returns null for a foreign artifact", async () => {
    await computeEntityChangeToken({ kind: "artifact", id: ID }, "ws-1");
    expect(mocks.artifactFindFirst.mock.calls[0][0].where).toEqual({ id: ID, workspaceId: "ws-1" });
    mocks.artifactFindFirst.mockResolvedValue(null);
    expect(await computeEntityChangeToken({ kind: "artifact", id: ID }, "ws-other")).toBeNull();
  });

  it("changes when a new revision becomes current", async () => {
    const base = await computeEntityChangeToken({ kind: "artifact", id: ID }, "ws-1");
    mocks.artifactFindFirst.mockResolvedValue({ ...artifactRow, currentRevisionId: "r2" });
    expect(await computeEntityChangeToken({ kind: "artifact", id: ID }, "ws-1")).not.toBe(base);
  });
});

describe("computeEntityChangeToken: docs-tree", () => {
  it("reads only the workspace's docs and ACTIVE artifacts, never content", async () => {
    await computeEntityChangeToken({ kind: "docs-tree" }, "ws-1");
    const docArgs = mocks.docFindMany.mock.calls[0][0];
    expect(docArgs.where).toEqual({ workspaceId: "ws-1" });
    expect(docArgs.select).not.toHaveProperty("content");
    expect(mocks.artifactFindMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1", status: "ACTIVE" });
  });

  it("changes on rename, move and add", async () => {
    const row = { id: "d1", title: "A", icon: null, parentId: null, sortOrder: 0, docType: "STANDARD" };
    mocks.docFindMany.mockResolvedValue([row]);
    const base = await computeEntityChangeToken({ kind: "docs-tree" }, "ws-1");
    mocks.docFindMany.mockResolvedValue([{ ...row, title: "B" }]);
    const renamed = await computeEntityChangeToken({ kind: "docs-tree" }, "ws-1");
    mocks.docFindMany.mockResolvedValue([{ ...row, parentId: "d0" }]);
    const moved = await computeEntityChangeToken({ kind: "docs-tree" }, "ws-1");
    mocks.docFindMany.mockResolvedValue([row]);
    mocks.artifactFindMany.mockResolvedValue([{ id: "a1", title: "x", sourceType: "HTML_UPLOAD", updatedAt: T1 }]);
    const added = await computeEntityChangeToken({ kind: "docs-tree" }, "ws-1");
    expect(new Set([base, renamed, moved, added]).size).toBe(4);
  });
});
