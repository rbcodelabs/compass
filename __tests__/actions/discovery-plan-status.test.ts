/**
 * Unit tests for the plan approve/reject server actions
 * (approveSolutionPlan, rejectSolutionPlan) in discovery/actions.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSolutionComment = {
  findUnique: vi.fn(),
  update: vi.fn(),
};

const mockPrisma = {
  solutionComment: mockSolutionComment,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  approveSolutionPlan,
  rejectSolutionPlan,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

const mockAuth = vi.mocked(auth);
const COMMENT_ID = "comment-1";
const PATH = "/org/ws/discovery/opp-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  mockSolutionComment.findUnique.mockResolvedValue({
    id: COMMENT_ID,
    commentType: "PLAN",
  });
  mockSolutionComment.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, commentType: "PLAN", ...data })
  );
});

describe("approveSolutionPlan", () => {
  it("throws Unauthorized when there is no session", async () => {
    mockAuth.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof auth>>);

    await expect(approveSolutionPlan(COMMENT_ID, PATH)).rejects.toThrow("Unauthorized");
    expect(mockSolutionComment.update).not.toHaveBeenCalled();
  });

  it("throws when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null);

    await expect(approveSolutionPlan(COMMENT_ID, PATH)).rejects.toThrow("not found");
    expect(mockSolutionComment.update).not.toHaveBeenCalled();
  });

  it("refuses to approve a COMMENT (only PLAN entries qualify)", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      commentType: "COMMENT",
    });

    await expect(approveSolutionPlan(COMMENT_ID, PATH)).rejects.toThrow(
      "Only PLAN entries can be approved or rejected"
    );
    expect(mockSolutionComment.update).not.toHaveBeenCalled();
  });

  it("sets planStatus to APPROVED and updatedAt explicitly (no DB trigger on DSQL)", async () => {
    await approveSolutionPlan(COMMENT_ID, PATH);

    expect(mockSolutionComment.update).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { planStatus: "APPROVED", updatedAt: expect.any(Date) },
    });
    expect(revalidatePath).toHaveBeenCalledWith(PATH);
  });
});

describe("rejectSolutionPlan", () => {
  it("throws Unauthorized when there is no session", async () => {
    mockAuth.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof auth>>);

    await expect(rejectSolutionPlan(COMMENT_ID, PATH)).rejects.toThrow("Unauthorized");
    expect(mockSolutionComment.update).not.toHaveBeenCalled();
  });

  it("throws when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null);

    await expect(rejectSolutionPlan(COMMENT_ID, PATH)).rejects.toThrow("not found");
    expect(mockSolutionComment.update).not.toHaveBeenCalled();
  });

  it("refuses to reject a COMMENT (only PLAN entries qualify)", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      commentType: "COMMENT",
    });

    await expect(rejectSolutionPlan(COMMENT_ID, PATH)).rejects.toThrow(
      "Only PLAN entries can be approved or rejected"
    );
    expect(mockSolutionComment.update).not.toHaveBeenCalled();
  });

  it("sets planStatus to REJECTED and updatedAt explicitly (no DB trigger on DSQL)", async () => {
    await rejectSolutionPlan(COMMENT_ID, PATH);

    expect(mockSolutionComment.update).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { planStatus: "REJECTED", updatedAt: expect.any(Date) },
    });
    expect(revalidatePath).toHaveBeenCalledWith(PATH);
  });
});
