import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFeedbackItem = {
  update: vi.fn(),
  create: vi.fn(),
};

const mockFeedbackAttachment = {
  findFirst: vi.fn(),
};

const mockWorkspace = {
  findFirst: vi.fn(),
};

const mockPrisma = {
  feedbackItem: mockFeedbackItem,
  feedbackAttachment: mockFeedbackAttachment,
  workspace: mockWorkspace,
};

const { mockVerifyCompleted, mockVerifyOwnership, mockPrepareUpload, mockDeleteBlobs } = vi.hoisted(() => ({
  mockVerifyCompleted: vi.fn(),
  mockVerifyOwnership: vi.fn(),
  mockPrepareUpload: vi.fn(),
  mockDeleteBlobs: vi.fn(),
}));

vi.mock("@/lib/feedback-attachments", () => ({
  verifyCompletedFeedbackUpload: mockVerifyCompleted,
  verifyFeedbackUploadOwnership: mockVerifyOwnership,
  prepareFeedbackAttachmentUpload: mockPrepareUpload,
  deleteFeedbackBlobs: mockDeleteBlobs,
}));

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
  prepareFeedbackAttachment,
  discardFeedbackAttachment,
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

    // Membership, not just a session: a server action is a public endpoint.
    expect(mockWorkspace.findFirst).toHaveBeenCalledWith({
      where: {
        slug: "widgets",
        organization: { slug: "acme" },
        members: { some: { userId: "user-1" } },
      },
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

describe("createFeedback with attachments", () => {
  const upload = (n: number) => ({
    url: `https://store.public.blob.vercel-storage.com/feedback/ws-1/${n}.png`,
    receipt: `receipt-${n}`,
  });

  beforeEach(() => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", name: "Dev User", email: "dev@localhost.dev" },
    } as ReturnType<typeof auth> extends Promise<infer T> ? T : never);
    mockVerifyCompleted.mockImplementation(async ({ url, receipt }: { url: string; receipt: string }) => ({
      attachmentId: `att-${receipt}`,
      url,
      filename: "shot.png",
      fileType: "image/png",
      fileSize: 42,
    }));
  });

  it("verifies each upload against this workspace with a grace window, then creates item + rows in one write", async () => {
    const result = await createFeedback(
      "acme",
      "widgets",
      { title: "Bug", description: "## Steps", type: "BUG", attachments: [upload(1), upload(2)] },
      "/acme/widgets/feedback"
    );

    expect(result.ok).toBe(true);
    expect(mockVerifyCompleted).toHaveBeenCalledTimes(2);
    expect(mockVerifyCompleted).toHaveBeenCalledWith(
      { workspaceId: "ws-1", url: upload(1).url, receipt: "receipt-1" },
      { graceMs: 24 * 60 * 60 * 1000 },
    );
    expect(mockFeedbackItem.create).toHaveBeenCalledTimes(1);
    expect(mockFeedbackItem.create.mock.calls[0][0].data).toMatchObject({
      description: "## Steps",
      type: "BUG",
      attachments: {
        create: [
          { id: "att-receipt-1", url: upload(1).url, filename: "shot.png", fileType: "image/png", fileSize: 42 },
          { id: "att-receipt-2", url: upload(2).url, filename: "shot.png", fileType: "image/png", fileSize: 42 },
        ],
      },
    });
  });

  it("creates nothing and names the failing upload when one cannot be verified", async () => {
    mockVerifyCompleted
      .mockResolvedValueOnce({ attachmentId: "a1", url: upload(1).url, filename: "a", fileType: "image/png", fileSize: 1 })
      .mockRejectedValueOnce(new Error("Completed upload does not match its receipt."));

    const result = await createFeedback(
      "acme",
      "widgets",
      { title: "Bug", description: "", type: "BUG", attachments: [upload(1), upload(2)] },
      "/path"
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/could not be verified/),
      attachmentUrl: upload(2).url,
    });
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("de-duplicates the same receipt submitted twice", async () => {
    await createFeedback(
      "acme",
      "widgets",
      { title: "Bug", description: "", type: "BUG", attachments: [upload(1), upload(1)] },
      "/path"
    );
    expect(mockFeedbackItem.create.mock.calls[0][0].data.attachments.create).toHaveLength(1);
  });

  it("refuses more than five attachments before touching storage or the DB", async () => {
    const result = await createFeedback(
      "acme",
      "widgets",
      { title: "Bug", description: "", type: "BUG", attachments: [1, 2, 3, 4, 5, 6].map(upload) },
      "/path"
    );
    expect(result).toEqual({ ok: false, error: "Attach at most 5 files." });
    expect(mockVerifyCompleted).not.toHaveBeenCalled();
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown type rather than persisting it", async () => {
    const result = await createFeedback(
      "acme",
      "widgets",
      { title: "Bug", description: "", type: "QUESTION" as never },
      "/path"
    );
    expect(result).toEqual({ ok: false, error: "Type must be Idea or Bug" });
    expect(mockFeedbackItem.create).not.toHaveBeenCalled();
  });
});

describe("prepareFeedbackAttachment", () => {
  const png = { filename: "shot.png", fileType: "image/png", fileSize: 1024 };

  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store_secret";
    mockPrepareUpload.mockResolvedValue({
      clientToken: "client-token",
      receipt: "receipt",
      pathname: "feedback/ws-1/x-shot.png",
      expiresAt: 123,
      attachmentId: "att-1",
    });
  });

  it("mints an upload for a member's workspace", async () => {
    const result = await prepareFeedbackAttachment("acme", "widgets", png);
    expect(result).toEqual({
      ok: true,
      upload: { clientToken: "client-token", receipt: "receipt", pathname: "feedback/ws-1/x-shot.png", expiresAt: 123 },
    });
    expect(mockPrepareUpload).toHaveBeenCalledWith({ workspaceId: "ws-1", ...png });
  });

  it.each([
    ["an unsupported type", { ...png, fileType: "application/zip" }, /unsupported file type/],
    ["an oversize file", { ...png, fileSize: 11 * 1024 * 1024 }, /larger than 10 MB/],
    ["an empty file", { ...png, fileSize: 0 }, /is empty/],
  ])("rejects %s without minting a token", async (_label, file, message) => {
    const result = await prepareFeedbackAttachment("acme", "widgets", file);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(message) });
    expect(mockPrepareUpload).not.toHaveBeenCalled();
  });

  it("refuses non-members", async () => {
    mockWorkspace.findFirst.mockResolvedValue(null);
    expect(await prepareFeedbackAttachment("acme", "widgets", png)).toEqual({ ok: false, error: "Workspace not found" });
    expect(mockPrepareUpload).not.toHaveBeenCalled();
  });

  it("returns a result instead of throwing when signed out", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect(await prepareFeedbackAttachment("acme", "widgets", png)).toEqual({ ok: false, error: "You are not signed in." });
  });

  it("explains when Blob storage is not configured", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const result = await prepareFeedbackAttachment("acme", "widgets", png);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not available|aren’t available/) });
  });
});

describe("discardFeedbackAttachment", () => {
  const upload = { url: "https://store.public.blob.vercel-storage.com/feedback/ws-1/x.png", receipt: "r" };

  beforeEach(() => {
    mockVerifyOwnership.mockReturnValue({ pathname: "feedback/ws-1/x.png" });
    mockFeedbackAttachment.findFirst.mockResolvedValue(null);
  });

  it("deletes an unlinked blob the server minted for this workspace", async () => {
    expect(await discardFeedbackAttachment("acme", "widgets", upload)).toEqual({ ok: true });
    expect(mockVerifyOwnership).toHaveBeenCalledWith(
      { workspaceId: "ws-1", url: upload.url, receipt: "r" },
      { graceMs: 24 * 60 * 60 * 1000 },
    );
    expect(mockDeleteBlobs).toHaveBeenCalledWith([upload.url]);
  });

  it("never deletes a blob that is already linked to a feedback item", async () => {
    mockFeedbackAttachment.findFirst.mockResolvedValue({ id: "att-1" });
    const result = await discardFeedbackAttachment("acme", "widgets", upload);
    expect(result.ok).toBe(false);
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });

  it("never deletes when the receipt does not match", async () => {
    mockVerifyOwnership.mockImplementation(() => { throw new Error("Upload URL does not match its receipt."); });
    const result = await discardFeedbackAttachment("acme", "widgets", upload);
    expect(result).toEqual({ ok: false, error: "Upload URL does not match its receipt." });
    expect(mockDeleteBlobs).not.toHaveBeenCalled();
  });
});
