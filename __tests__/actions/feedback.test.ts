import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFeedbackItem = {
  update: vi.fn(),
  create: vi.fn(),
};

const mockWorkspace = {
  findFirst: vi.fn(),
};

const mockPrisma = {
  feedbackItem: mockFeedbackItem,
  workspace: mockWorkspace,
};

vi.mock("@/lib/db", () => ({
  default: vi.fn(() => mockPrisma),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import {
  updateFeedbackStatus,
  linkFeedbackToOpportunity,
  updateFeedbackType,
  createFeedback,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";

const mockAuth = vi.mocked(auth);
const mockRevalidatePath = vi.mocked(revalidatePath);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  mockFeedbackItem.update.mockResolvedValue({ id: "fb-1" });
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1" });
  mockFeedbackItem.create.mockResolvedValue({
    id: "fb-new",
    title: "New idea",
    description: null,
    submitterName: "Dev User",
    submitterEmail: "dev@localhost.dev",
    status: "OPEN",
    voteCount: 0,
    type: "IDEA",
    opportunityId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

// ─── updateFeedbackStatus ─────────────────────────────────────────────────────
//
// DELIBERATE TEST CHANGE (see PR body): these three actions used to be
// `Promise<void>` that threw, and the tests below asserted `rejects.toThrow`.
// They now resolve a discriminated `{ ok: true } | { ok: false; error }`.
//
// Why: a server action that throws surfaces in the browser as an *unhandled
// rejection* with the message stripped in production, so the DataGrid's
// optimistic overlay could never observe the failure and could never roll the
// cell back. `rejects.toThrow` was therefore asserting the exact behaviour that
// makes inline editing unrecoverable. The assertions are inverted, not deleted:
// every former "throws X" case is now a "returns { ok: false } and does not
// touch the DB" case, so the same conditions are still covered.
//
// Every write also now sets `updatedAt` explicitly — DSQL has no `@updatedAt`
// trigger support, so the column is otherwise never bumped.

describe("updateFeedbackStatus", () => {
  it("updates the status field and stamps updatedAt", async () => {
    const result = await updateFeedbackStatus("fb-1", "REVIEWED", "/path");
    expect(result).toEqual({ ok: true });
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { status: "REVIEWED", updatedAt: expect.any(Date) },
    });
  });

  it("returns an error result instead of throwing when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateFeedbackStatus("fb-1", "REVIEWED", "/path")
    ).resolves.toEqual({ ok: false, error: "You are not signed in." });
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("returns an error result when user id is absent", async () => {
    mockAuth.mockResolvedValue({ user: {} } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    await expect(
      updateFeedbackStatus("fb-1", "REVIEWED", "/path")
    ).resolves.toEqual({ ok: false, error: "You are not signed in." });
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("converts DB errors into an error result rather than rejecting", async () => {
    mockFeedbackItem.update.mockRejectedValue(new Error("not found"));
    await expect(
      updateFeedbackStatus("fb-999", "NEW", "/path")
    ).resolves.toEqual({ ok: false, error: "not found" });
  });

  it("never rejects, so the grid's rollback path always runs", async () => {
    mockFeedbackItem.update.mockRejectedValue(new Error("boom"));
    // If this ever rejects again, an inline edit becomes an unhandled rejection
    // and the optimistic cell is stuck showing a value the server refused.
    const result = await updateFeedbackStatus("fb-1", "OPEN", "/path").catch(
      () => "REJECTED" as const
    );
    expect(result).not.toBe("REJECTED");
  });

  it("revalidates when given a path", async () => {
    await updateFeedbackStatus("fb-1", "OPEN", "/acme/widgets/feedback");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/widgets/feedback");
  });

  it("skips revalidation entirely when the path is null", async () => {
    // The DataGrid's inline edits pass null on purpose. A Server Action that
    // revalidates *anything* makes Next re-deliver the calling route's RSC
    // payload, which pulls the just-edited row out from under the user and
    // destroys the grid's stay-and-mark behaviour. Verified in a real browser
    // (see e2e/functional/specs/feedback-grid.spec.ts).
    const result = await updateFeedbackStatus("fb-1", "OPEN", null);
    expect(result).toEqual({ ok: true });
    expect(mockFeedbackItem.update).toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
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
    const result = await linkFeedbackToOpportunity("fb-1", "opp-1", "/path");
    expect(result).toEqual({ ok: true });
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { opportunityId: "opp-1", updatedAt: expect.any(Date) },
    });
  });

  it("clears the opportunity link when null is passed", async () => {
    await linkFeedbackToOpportunity("fb-1", null, "/path");
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { opportunityId: null, updatedAt: expect.any(Date) },
    });
  });

  it("returns an error result instead of throwing when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      linkFeedbackToOpportunity("fb-1", "opp-1", "/path")
    ).resolves.toEqual({ ok: false, error: "You are not signed in." });
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("converts DB errors into an error result rather than rejecting", async () => {
    mockFeedbackItem.update.mockRejectedValue(new Error("DB error"));
    await expect(
      linkFeedbackToOpportunity("fb-999", "opp-1", "/path")
    ).resolves.toEqual({ ok: false, error: "DB error" });
  });

  it("skips revalidation entirely when the path is null", async () => {
    await linkFeedbackToOpportunity("fb-1", "opp-1", null);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

// ─── updateFeedbackType ───────────────────────────────────────────────────────

describe("updateFeedbackType", () => {
  it("updates the type field to BUG", async () => {
    const result = await updateFeedbackType("fb-1", "BUG", "/path");
    expect(result).toEqual({ ok: true });
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { type: "BUG", updatedAt: expect.any(Date) },
    });
  });

  it("updates the type field to IDEA", async () => {
    await updateFeedbackType("fb-1", "IDEA", "/path");
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: "fb-1" },
      data: { type: "IDEA", updatedAt: expect.any(Date) },
    });
  });

  it("returns an error result instead of throwing when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      updateFeedbackType("fb-1", "BUG", "/path")
    ).resolves.toEqual({ ok: false, error: "You are not signed in." });
    expect(mockFeedbackItem.update).not.toHaveBeenCalled();
  });

  it("converts DB errors into an error result rather than rejecting", async () => {
    mockFeedbackItem.update.mockRejectedValue(new Error("not found"));
    await expect(
      updateFeedbackType("fb-999", "BUG", "/path")
    ).resolves.toEqual({ ok: false, error: "not found" });
  });

  it("skips revalidation entirely when the path is null", async () => {
    await updateFeedbackType("fb-1", "BUG", null);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

// ─── createFeedback ───────────────────────────────────────────────────────────

describe("createFeedback", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", name: "Dev User", email: "dev@localhost.dev" },
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
  });

  it("creates a feedback item scoped to the resolved workspace and returns it", async () => {
    const result = await createFeedback(
      "acme",
      "widgets",
      { title: "New idea", description: "", type: "IDEA" },
      "/acme/widgets/feedback"
    );

    expect(mockWorkspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "widgets", organization: { slug: "acme" } },
      select: { id: true },
    });
    expect(mockFeedbackItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          title: "New idea",
          description: null,
          type: "IDEA",
          submitterName: "Dev User",
          submitterEmail: "dev@localhost.dev",
        }),
      })
    );
    expect(result).toEqual({
      ok: true,
      item: expect.objectContaining({ id: "fb-new", title: "New idea" }),
    });
  });

  it("uses the authenticated session's name/email, not any client-supplied value", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", name: "Session Name", email: "session@example.com" },
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);

    await createFeedback(
      "acme",
      "widgets",
      { title: "Idea", description: "", type: "IDEA" },
      "/path"
    );

    expect(mockFeedbackItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          submitterName: "Session Name",
          submitterEmail: "session@example.com",
        }),
      })
    );
  });

  it("throws Unauthorized when session is missing", async () => {
    mockAuth.mockResolvedValue(null as never);
    await expect(
      createFeedback("acme", "widgets", { title: "Idea", description: "", type: "IDEA" }, "/path")
    ).rejects.toThrow("Unauthorized");
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("returns a validation error and does not touch the DB when title is blank", async () => {
    const result = await createFeedback(
      "acme",
      "widgets",
      { title: "   ", description: "", type: "IDEA" },
      "/path"
    );

    expect(result).toEqual({ ok: false, error: "Title is required" });
    expect(mockWorkspace.findFirst).not.toHaveBeenCalled();
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("returns a not-found error when the workspace doesn't resolve", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);

    const result = await createFeedback(
      "acme",
      "missing-workspace",
      { title: "Idea", description: "", type: "IDEA" },
      "/path"
    );

    expect(result).toEqual({ ok: false, error: "Workspace not found" });
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("propagates DB errors", async () => {
    mockFeedbackItem.create.mockRejectedValue(new Error("DB error"));
    await expect(
      createFeedback("acme", "widgets", { title: "Idea", description: "", type: "IDEA" }, "/path")
    ).rejects.toThrow("DB error");
  });
});
