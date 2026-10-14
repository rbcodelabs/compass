/**
 * Permission matrix for the canvas card server actions: the workspace comes
 * from the doc, never the client, and non-members never reach the resolver.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userId: null as string | null,
  doc: { workspaceId: "ws-a" } as { workspaceId: string } | null,
  workspaceFor: vi.fn(),
  resolveCanvasCards: vi.fn(async () => ({ resolved: true })),
  searchCanvasCardTargets: vi.fn(async () => [{ kind: "doc", id: "x", title: "T" }]),
  getCanvasOverview: vi.fn(),
}));

const prisma = {
  doc: { findUnique: vi.fn(async () => h.doc) },
  workspace: { findFirst: vi.fn(async (args: unknown) => h.workspaceFor(args)), findUnique: vi.fn(async () => ({ id: "ws-a", thinkingModel: null, thinkingModelLabels: null })) },
};

vi.mock("@/lib/db", () => ({ default: () => prisma }));
vi.mock("@/auth", () => ({ auth: async () => (h.userId ? { user: { id: h.userId, name: "U", email: "u@x.com" } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/canvas-card-data", () => ({
  resolveCanvasCards: h.resolveCanvasCards,
  searchCanvasCardTargets: h.searchCanvasCardTargets,
}));
vi.mock("@/lib/canvas/data", () => ({ getCanvasOverview: h.getCanvasOverview }));
vi.mock("@/lib/document-service", () => ({}));
vi.mock("@/lib/doc-comments", () => ({}));
vi.mock("@/lib/positioning-brief", () => ({}));
vi.mock("@/lib/artifacts", () => ({ MAX_ARTIFACT_HTML_BYTES: 1 }));
vi.mock("@/lib/artifact-storage", () => ({}));
vi.mock("@/lib/linked-tasks", () => ({}));
vi.mock("@/lib/task-assignment", () => ({}));
vi.mock("@/lib/launch-checklist", () => ({}));

import { buildCanvasTree, resolveCanvasCardRefs, searchCanvasCardItems } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

const workspace = { id: "ws-a", slug: "ws", organization: { slug: "org" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.userId = "user-1";
  h.doc = { workspaceId: "ws-a" };
  h.workspaceFor.mockReturnValue(workspace);
});

describe("resolveCanvasCardRefs", () => {
  it("rejects unauthenticated callers before touching data", async () => {
    h.userId = null;
    await expect(resolveCanvasCardRefs("doc", [])).rejects.toThrow("Unauthorized");
    expect(h.resolveCanvasCards).not.toHaveBeenCalled();
  });

  it("rejects non-members and never resolves cards for them", async () => {
    h.workspaceFor.mockReturnValue(null);
    await expect(resolveCanvasCardRefs("doc", [{ kind: "doc", id: "x" }])).rejects.toThrow(/denied/);
    expect(h.resolveCanvasCards).not.toHaveBeenCalled();
  });

  it("checks membership (or org read-only access) for the doc's workspace and passes that workspace through", async () => {
    const refs = [{ kind: "task", id: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f" }];
    await resolveCanvasCardRefs("doc", refs);
    const where = (h.workspaceFor.mock.calls[0][0] as { where: { id: string; OR: unknown[] } }).where;
    expect(where.id).toBe("ws-a");
    expect(JSON.stringify(where.OR)).toContain("memberWorkspaceReadOnlyAccess");
    expect(h.resolveCanvasCards).toHaveBeenCalledWith({ userId: "user-1", workspaceId: "ws-a", workspaceSlug: "ws", orgSlug: "org", refs });
  });

  it("fails for a missing doc and ignores a non-array refs payload", async () => {
    h.doc = null;
    await expect(resolveCanvasCardRefs("doc", [])).rejects.toThrow("Document not found");
    h.doc = { workspaceId: "ws-a" };
    expect(await resolveCanvasCardRefs("doc", "nope")).toEqual({});
  });
});

describe("searchCanvasCardItems", () => {
  it("requires workspace membership and scopes the search to the doc's workspace", async () => {
    h.workspaceFor.mockReturnValue({ id: "ws-a" });
    await searchCanvasCardItems("doc", "login");
    expect(h.searchCanvasCardTargets).toHaveBeenCalledWith({ workspaceId: "ws-a", query: "login" });
  });

  it("rejects non-members", async () => {
    h.workspaceFor.mockReturnValue(null);
    await expect(searchCanvasCardItems("doc", "login")).rejects.toThrow(/denied/);
    expect(h.searchCanvasCardTargets).not.toHaveBeenCalled();
  });
});

describe("buildCanvasTree", () => {
  const O1 = "00000000-0000-4000-8000-000000000001";
  const KR1 = "00000000-0000-4000-8000-000000000002";
  const overview = () => ({
    objectives: [{ id: O1, title: "Grow", status: "ON_TRACK", squad: null, position: null }],
    keyResults: [{ id: KR1, objectiveId: O1, title: "KR", current: 0, target: 1, unit: null, position: null }],
    opportunities: [], solutions: [], assumptions: [], experiments: [], roadmapItems: [],
  });

  it("rejects unauthenticated callers and non-members before reading the tree", async () => {
    h.userId = null;
    await expect(buildCanvasTree("doc", { kind: "workspace" })).rejects.toThrow("Unauthorized");
    h.userId = "user-1";
    h.workspaceFor.mockReturnValue(null);
    await expect(buildCanvasTree("doc", { kind: "workspace" })).rejects.toThrow(/denied/);
    expect(h.getCanvasOverview).not.toHaveBeenCalled();
  });

  it("reads the overview of the doc's workspace, never a client-supplied one", async () => {
    h.getCanvasOverview.mockResolvedValue(overview());
    const fragment = await buildCanvasTree("doc", { kind: "workspace", workspaceId: "ws-evil" });
    expect(h.getCanvasOverview).toHaveBeenCalledWith(prisma, "ws-a", expect.any(Object));
    expect(fragment.cards.map((c) => c.ref.id)).toEqual([O1, KR1]);
    expect(fragment.edges).toHaveLength(1);
  });

  it("scopes to an item, and treats an id outside the workspace as an empty tree", async () => {
    h.getCanvasOverview.mockResolvedValue(overview());
    expect((await buildCanvasTree("doc", { kind: "keyResult", id: KR1.toUpperCase() })).cards.map((c) => c.ref.id)).toEqual([KR1]);
    expect((await buildCanvasTree("doc", { kind: "objective", id: "00000000-0000-4000-8000-0000000000ff" })).cards).toEqual([]);
  });

  it("rejects a malformed scope", async () => {
    h.getCanvasOverview.mockResolvedValue(overview());
    await expect(buildCanvasTree("doc", { kind: "objective", id: "not-a-uuid" })).rejects.toThrow("Invalid tree scope");
    await expect(buildCanvasTree("doc", { kind: "doc", id: O1 })).rejects.toThrow("Invalid tree scope");
  });
});
