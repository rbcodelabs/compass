import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetEligible = vi.fn();
vi.mock("@/lib/okr-hierarchy", () => ({
  getEligibleParentKeyResults: (...args: unknown[]) => mockGetEligible(...args),
}));

import { listEligibleParentKeyResults } from "@/lib/okr-tool-handlers";

beforeEach(() => vi.clearAllMocks());

describe("listEligibleParentKeyResults", () => {
  it("returns cycle, Objective, KR, and a parseable ID", async () => {
    mockGetEligible.mockResolvedValue([
      {
        id: "kr-id",
        title: "Reach $2M ARR",
        objectiveTitle: "Grow recurring revenue",
        cycleTitle: "2027 Annual",
      },
    ]);

    const result = await listEligibleParentKeyResults({ workspaceId: "ws-id", cycleId: "q1-id" });

    expect(mockGetEligible).toHaveBeenCalledWith("ws-id", "q1-id");
    expect(result.content[0].text).toContain("2027 Annual / Grow recurring revenue / Reach $2M ARR");
    expect(result.content[0].text).toContain("ID: kr-id");
  });

  it("returns a clear empty state", async () => {
    mockGetEligible.mockResolvedValue([]);
    const result = await listEligibleParentKeyResults({ workspaceId: "ws-id", cycleId: "q1-id" });
    expect(result.content[0].text).toBe("No eligible higher-level Key Results found.");
  });
});
