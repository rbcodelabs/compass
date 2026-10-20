import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, requireContext, loadSpecCanvas } = vi.hoisted(() => ({ findFirst: vi.fn(), requireContext: vi.fn(), loadSpecCanvas: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => ({ opportunity: { findFirst } }) }));
vi.mock("@/lib/workspace-context", () => ({ requireWorkspaceContext: requireContext }));
vi.mock("@/lib/spec-canvas/load", () => ({ loadSpecCanvas }));
vi.mock("@/components/discovery/spec-canvas/spec-document", () => ({ SpecDocument: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  permanentRedirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));
import OpportunitySpecPage from "@/app/[orgSlug]/[workspaceSlug]/discovery/[opportunityId]/spec/page";

const OPP_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const props = (opportunityId: string) => ({ params: Promise.resolve({ orgSlug: "org", workspaceSlug: "ws", opportunityId }) });
beforeEach(() => {
  vi.resetAllMocks();
  requireContext.mockResolvedValue({ workspace: { id: "ws-id" } });
});

describe("opportunity spec page", () => {
  it("is a 404 for a segment that is neither a UUID nor a display ID, without querying", async () => {
    await expect(OpportunitySpecPage(props("card-sort"))).rejects.toThrow("NOT_FOUND");
    expect(findFirst).not.toHaveBeenCalled();
    expect(loadSpecCanvas).not.toHaveBeenCalled();
  });
  it("is a 404 for an opportunity outside the authorized workspace", async () => {
    findFirst.mockResolvedValue(null);
    await expect(OpportunitySpecPage(props(OPP_ID))).rejects.toThrow("NOT_FOUND");
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: OPP_ID, workspaceId: "ws-id" });
    expect(loadSpecCanvas).not.toHaveBeenCalled();
  });
  it("resolves a display ID inside the workspace and loads by UUID", async () => {
    findFirst.mockResolvedValue({ id: OPP_ID, seqPrefix: "OPP", seqNumber: 4 });
    loadSpecCanvas.mockResolvedValue({});
    await OpportunitySpecPage(props("OPP-4"));
    expect(findFirst.mock.calls[0][0].where).toEqual({ workspaceId: "ws-id", seqPrefix: "OPP", seqNumber: 4 });
    expect(loadSpecCanvas).toHaveBeenCalledWith({ workspaceId: "ws-id", opportunityId: OPP_ID, orgSlug: "org", workspaceSlug: "ws" });
  });
  it("redirects a UUID for a numbered opportunity to the canonical display-ID spec URL", async () => {
    findFirst.mockResolvedValue({ id: OPP_ID, seqPrefix: "OPP", seqNumber: 4 });
    await expect(OpportunitySpecPage(props(OPP_ID))).rejects.toThrow("REDIRECT:/org/ws/discovery/OPP-4/spec");
  });
});
