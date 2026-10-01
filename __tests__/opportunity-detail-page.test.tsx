import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, getContext, requireContext } = vi.hoisted(() => ({ findFirst: vi.fn(), getContext: vi.fn(), requireContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => ({ opportunity: { findFirst } }) }));
vi.mock("@/lib/workspace-context", () => ({ getWorkspaceContext: getContext, requireWorkspaceContext: requireContext }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/components/discovery/opportunity-detail", () => ({ OpportunityDetail: () => null }));
import OpportunityDetailPage, { generateMetadata } from "@/app/[orgSlug]/[workspaceSlug]/discovery/[opportunityId]/page";

const OPP_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const params = Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", opportunityId: OPP_ID });
beforeEach(() => { vi.resetAllMocks(); });

describe("opportunity page access", () => {
  it.each(["unauthenticated", "not-found"])("does not disclose metadata to %s callers", async (status) => {
    getContext.mockResolvedValue({ status });
    expect(await generateMetadata({ params })).toEqual({ title: "Opportunity" });
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("scopes metadata and page existence to the authorized workspace", async () => {
    getContext.mockResolvedValue({ status: "ok", workspace: { id: "ws-id" } });
    requireContext.mockResolvedValue({ workspace: { id: "ws-id" } });
    findFirst.mockResolvedValue({ id: OPP_ID, title: "Our opportunity" });
    expect(await generateMetadata({ params })).toEqual({ title: "Our opportunity" });
    await OpportunityDetailPage({ params });
    expect(requireContext).toHaveBeenCalledWith("org", "ws");
    for (const [query] of findFirst.mock.calls) expect(query.where).toEqual({ id: OPP_ID, workspaceId: "ws-id" });
  });
  it("titles the page with the workspace's own word for an Opportunity", async () => {
    const workspace = { id: "ws-id", thinkingModel: "CLASSIC", thinkingModelLabels: JSON.stringify({ opportunity: { singular: "Problem" } }) };
    getContext.mockResolvedValue({ status: "ok", workspace });
    findFirst.mockResolvedValue(null);
    expect(await generateMetadata({ params })).toEqual({ title: "Problem" });
    expect(await generateMetadata({ params: Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", opportunityId: "card-sort" }) })).toEqual({ title: "Problem" });
    getContext.mockResolvedValue({ status: "ok", workspace: { id: "ws-id" } });
    expect(await generateMetadata({ params })).toEqual({ title: "Opportunity" });
  });
  it("returns not found for a foreign or missing opportunity", async () => {
    requireContext.mockResolvedValue({ workspace: { id: "ws-id" } });
    findFirst.mockResolvedValue(null);
    await expect(OpportunityDetailPage({ params })).rejects.toThrow("NOT_FOUND");
  });
  it("returns not found for a non-UUID path segment without querying", async () => {
    // e.g. a mistyped or bookmarked /discovery/card-sort: Opportunity.id is a
    // uuid column, so this must be a 404 and never reach Postgres as a 500.
    getContext.mockResolvedValue({ status: "not-found" });
    const bad = Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", opportunityId: "card-sort" });
    expect(await generateMetadata({ params: bad })).toEqual({ title: "Opportunity" });
    await expect(OpportunityDetailPage({ params: bad })).rejects.toThrow("NOT_FOUND");
    expect(findFirst).not.toHaveBeenCalled();
  });
});
