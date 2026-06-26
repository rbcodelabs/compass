import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFeedbackItem = {
  update: vi.fn(),
};

const mockPrisma = {
  feedbackItem: mockFeedbackItem,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import {
  updateFeedbackStatus,
  linkFeedbackToOpportunity,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  mockFeedbackItem.update.mockResolvedValue({ id: "fb-1" });
});

// ─── updateFeedbackStatus ─────────────────────────────────────────────────────

describe("updateFeedbackStatus", () => {
  it("updates the status field", async () => {
    await updateFeedbackStatus("fb-1", "REVIEWED", "/path");
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { status: "REVIEWED" },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(
      updateFeedbackStatus("fb-1", "REVIEWED", "/path")
    ).rejects.toThrow("Unauthorized");
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("throws Unauthorized when user id is absent", async () => {
    mockAuth.mockResolvedValue({ user: {} } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    await expect(
      updateFeedbackStatus("fb-1", "REVIEWED", "/path")
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates DB errors", async () => {
    mockFeedbackItem.update.mockRejectedValue(new Error("not found"));
    await expect(
      updateFeedbackStatus("fb-999", "NEW", "/path")
    ).rejects.toThrow("not found");
  });

  it("accepts any status string (no Zod validation on this field)", async () => {
    await updateFeedbackStatus("fb-1", "ARCHIVED", "/path");
    const data = mockFeedbackItem.update.mock.calls[0][0].data;
    expect(data.status).toBe("ARCHIVED");
  });
});

// ─── linkFeedbackToOpportunity ────────────────────────────────────────────────

describe("linkFeedbackToOpportunity", () => {
  it("links feedback to an opportunity", async () => {
    await linkFeedbackToOpportunity("fb-1", "opp-1", "/path");
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { opportunityId: "opp-1" },
    });
  });

  it("clears the opportunity link when null is passed", async () => {
    await linkFeedbackToOpportunity("fb-1", null, "/path");
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { opportunityId: null },
    });
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(
      linkFeedbackToOpportunity("fb-1", "opp-1", "/path")
    ).rejects.toThrow("Unauthorized");
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("propagates DB errors", async () => {
    mockFeedbackItem.update.mockRejectedValue(new Error("DB error"));
    await expect(
      linkFeedbackToOpportunity("fb-999", "opp-1", "/path")
    ).rejects.toThrow("DB error");
  });
});
