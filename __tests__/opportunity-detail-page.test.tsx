import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, getContext, requireContext } = vi.hoisted(() => ({ findFirst: vi.fn(), getContext: vi.fn(), requireContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => ({ opportunity: { findFirst } }) }));
vi.mock("@/lib/workspace-context", () => ({ getWorkspaceContext: getContext, requireWorkspaceContext: requireContext }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/components/discovery/opportunity-detail", () => ({ OpportunityDetail: () => null }));
import OpportunityDetailPage, { generateMetadata } from "@/app/[orgSlug]/[workspaceSlug]/discovery/[opportunityId]/page";

const params = Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", opportunityId: "opp" });
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
    findFirst.mockResolvedValue({ id: "opp", title: "Our opportunity" });
    expect(await generateMetadata({ params })).toEqual({ title: "Our opportunity" });
    await OpportunityDetailPage({ params });
    expect(requireContext).toHaveBeenCalledWith("org", "ws");
    for (const [query] of findFirst.mock.calls) expect(query.where).toEqual({ id: "opp", workspaceId: "ws-id" });
  });
  it("returns not found for a foreign or missing opportunity", async () => {
    requireContext.mockResolvedValue({ workspace: { id: "ws-id" } });
    findFirst.mockResolvedValue(null);
    await expect(OpportunityDetailPage({ params })).rejects.toThrow("NOT_FOUND");
  });
});
