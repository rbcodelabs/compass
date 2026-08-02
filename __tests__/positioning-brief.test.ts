/**
 * Unit tests for createPositioningBriefCore (lib/positioning-brief.ts): item
 * validation, the already-linked idempotency guard (Doc.roadmapItemId is
 * unique), and the templated-doc creation with the right docType /
 * roadmapItemId / GTM template body. Prisma is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRoadmapItem = { findFirst: vi.fn() };
const mockDoc = { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() };

const mockPrisma = { roadmapItem: mockRoadmapItem, doc: mockDoc };

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }));

import { createPositioningBriefCore } from "@/lib/positioning-brief";
import { GTM_POSITIONING_BRIEF_TEMPLATE } from "@/lib/gtm-templates";

const WORKSPACE_ID = "ws-1";
const ITEM_ID = "item-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockRoadmapItem.findFirst.mockResolvedValue({ id: ITEM_ID, title: "Ship payments" });
  mockDoc.findUnique.mockResolvedValue(null); // no existing brief by default
  mockDoc.findFirst.mockResolvedValue({ sortOrder: 4 }); // last sibling
  mockDoc.create.mockResolvedValue({ id: "doc-1", title: "Positioning Brief — Ship payments" });
});

describe("createPositioningBriefCore", () => {
  it("returns item_not_found when the roadmap item isn't in the workspace", async () => {
    mockRoadmapItem.findFirst.mockResolvedValueOnce(null);

    const result = await createPositioningBriefCore(ITEM_ID, WORKSPACE_ID);

    expect(result).toEqual({ ok: false, error: "item_not_found" });
    expect(mockDoc.create).not.toHaveBeenCalled();
  });

  it("scopes the item lookup to the workspace (IDOR boundary)", async () => {
    await createPositioningBriefCore(ITEM_ID, WORKSPACE_ID);
    expect(mockRoadmapItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM_ID, workspaceId: WORKSPACE_ID } })
    );
  });

  it("returns the existing brief with created:false when one is already linked", async () => {
    mockDoc.findUnique.mockResolvedValueOnce({ id: "existing-doc", title: "Old Brief" });

    const result = await createPositioningBriefCore(ITEM_ID, WORKSPACE_ID);

    expect(result).toEqual({ ok: true, docId: "existing-doc", title: "Old Brief", created: false });
    expect(mockDoc.create).not.toHaveBeenCalled();
  });

  it("creates a templated brief with docType, roadmapItemId, and the GTM template body", async () => {
    const result = await createPositioningBriefCore(ITEM_ID, WORKSPACE_ID);

    const data = mockDoc.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe(WORKSPACE_ID);
    expect(data.roadmapItemId).toBe(ITEM_ID);
    expect(data.docType).toBe("GTM_POSITIONING_BRIEF");
    expect(data.content).toBe(GTM_POSITIONING_BRIEF_TEMPLATE);
    expect(data.title).toBe("Positioning Brief — Ship payments");
    // Placed after the last sibling (sortOrder 4 → 5).
    expect(data.sortOrder).toBe(5);
    expect(result).toEqual({ ok: true, docId: "doc-1", title: "Positioning Brief — Ship payments", created: true });
  });

  it("uses sortOrder 0 when there is no existing sibling doc", async () => {
    mockDoc.findFirst.mockResolvedValueOnce(null);
    await createPositioningBriefCore(ITEM_ID, WORKSPACE_ID);
    expect(mockDoc.create.mock.calls[0][0].data.sortOrder).toBe(0);
  });
});
