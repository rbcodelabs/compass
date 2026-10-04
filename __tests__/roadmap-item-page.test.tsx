import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, getContext, requireContext } = vi.hoisted(() => ({ findFirst: vi.fn(), getContext: vi.fn(), requireContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => ({ roadmapItem: { findFirst } }) }));
vi.mock("@/lib/workspace-context", () => ({ getWorkspaceContext: getContext, requireWorkspaceContext: requireContext }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/components/roadmap/roadmap-item-detail", () => ({ RoadmapItemDetail: () => null }));
import RoadmapItemPage, { generateMetadata } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/[itemId]/page";

const ITEM_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const params = Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", itemId: ITEM_ID });
beforeEach(() => { vi.resetAllMocks(); });

describe("roadmap item page access", () => {
  it.each(["unauthenticated", "not-found"])("does not disclose metadata to %s callers", async (status) => {
    getContext.mockResolvedValue({ status });
    expect(await generateMetadata({ params })).toEqual({ title: "Roadmap item" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes metadata and page existence to the authorized workspace, private items included", async () => {
    getContext.mockResolvedValue({ status: "ok", workspace: { id: "ws-id" } });
    requireContext.mockResolvedValue({ workspace: { id: "ws-id" } });
    findFirst.mockResolvedValue({ id: ITEM_ID, title: "A private item", isPrivate: true });
    expect(await generateMetadata({ params })).toEqual({ title: "A private item" });
    await RoadmapItemPage({ params });
    expect(requireContext).toHaveBeenCalledWith("org", "ws");
    for (const [query] of findFirst.mock.calls) expect(query.where).toEqual({ id: ITEM_ID, workspaceId: "ws-id" });
  });

  it("returns not found for a foreign or missing item", async () => {
    requireContext.mockResolvedValue({ workspace: { id: "ws-id" } });
    findFirst.mockResolvedValue(null);
    await expect(RoadmapItemPage({ params })).rejects.toThrow("NOT_FOUND");
  });

  it("returns not found for a non-UUID path segment without querying", async () => {
    getContext.mockResolvedValue({ status: "not-found" });
    const bad = Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", itemId: "not-a-uuid" });
    expect(await generateMetadata({ params: bad })).toEqual({ title: "Roadmap item" });
    await expect(RoadmapItemPage({ params: bad })).rejects.toThrow("NOT_FOUND");
    expect(findFirst).not.toHaveBeenCalled();
  });
});
