/**
 * Unit tests for app/api/admin/purge-feedback/route.ts.
 *
 * One-time-ops admin endpoint (mirrors app/api/admin/portal-sso-resync and
 * migrate's checkAuth() pattern): hard-deletes a specific, explicitly-listed
 * set of feedback items from a single workspace — used to purge spam that the
 * public (unauthenticated) portal feedback form lets through. Gated by
 * MIGRATION_SECRET, same trust boundary as the migrate route.
 *
 * Safety invariant under test: the endpoint requires BOTH a resolved
 * workspace AND a non-empty explicit id list, and it resolves the caller's ids
 * against FeedbackItem filtered by workspaceId BEFORE deleting anything. Every
 * delete — votes, attachments, items — is then driven off that resolved list.
 *
 * That resolve-first step is load-bearing, not stylistic: FeedbackVote and
 * FeedbackAttachment have no workspaceId column, so a child delete keyed on
 * raw caller-supplied ids has no tenancy filter at all and will hard-delete
 * another workspace's rows. The regression tests at the bottom of this file
 * pin that behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspaceFindFirst = vi.fn();
const mockVoteDeleteMany = vi.fn();
const mockAttachmentDeleteMany = vi.fn();
const mockItemDeleteMany = vi.fn();
const mockItemFindMany = vi.fn();
const mockAttachmentFindMany = vi.fn();
const mockQueryRaw = vi.fn();
const mockStoreDelete = vi.fn();

const mockPrisma = {
  workspace: { findFirst: mockWorkspaceFindFirst },
  feedbackVote: { deleteMany: mockVoteDeleteMany },
  feedbackAttachment: { deleteMany: mockAttachmentDeleteMany, findMany: mockAttachmentFindMany },
  $queryRaw: mockQueryRaw,
  feedbackItem: { deleteMany: mockItemDeleteMany, findMany: mockItemFindMany },
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}));

vi.mock("@/lib/storage/public-store", () => ({
  getPublicFileStore: () => ({ delete: mockStoreDelete, put: vi.fn(), fetch: vi.fn() }),
}));

import { POST } from "@/app/api/admin/purge-feedback/route";

const ORIGINAL_ENV = { ...process.env };

const IDS = [
  "65923984-916a-4633-9986-0f96f0759fc9",
  "c246d9f3-00f7-4ea0-98c2-9bbf5cbe304e",
];

function request(body: unknown, secret?: string) {
  return new NextRequest("http://localhost/api/admin/purge-feedback", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-migration-secret": secret } : {}),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAttachmentFindMany.mockResolvedValue([]);
  mockQueryRaw.mockResolvedValue([]);
  mockStoreDelete.mockResolvedValue(undefined);
  process.env.MIGRATION_SECRET = "test-migration-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/admin/purge-feedback", () => {
  it("rejects a request without the correct x-migration-secret header", async () => {
    const res = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: IDS }, "wrong-secret")
    );
    expect(res.status).toBe(401);
    expect(mockItemDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects (401) when MIGRATION_SECRET is not configured on the server", async () => {
    delete process.env.MIGRATION_SECRET;
    const res = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: IDS }, "anything")
    );
    expect(res.status).toBe(401);
    expect(mockItemDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 400 when feedbackIds is missing or empty (never a mass delete)", async () => {
    const resMissing = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "hiptrip" }, "test-migration-secret")
    );
    expect(resMissing.status).toBe(400);

    const resEmpty = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: [] }, "test-migration-secret")
    );
    expect(resEmpty.status).toBe(400);

    expect(mockItemDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 400 when feedbackIds contains a non-string entry", async () => {
    const res = await POST(
      request(
        { orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: ["ok", 123] },
        "test-migration-secret"
      )
    );
    expect(res.status).toBe(400);
    expect(mockItemDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 400 when orgSlug/workspaceSlug are missing", async () => {
    const res = await POST(request({ feedbackIds: IDS }, "test-migration-secret"));
    expect(res.status).toBe(400);
    expect(mockItemDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 when the org/workspace slug pair doesn't resolve", async () => {
    mockWorkspaceFindFirst.mockResolvedValue(null);
    const res = await POST(
      request({ orgSlug: "nope", workspaceSlug: "nope", feedbackIds: IDS }, "test-migration-secret")
    );
    expect(res.status).toBe(404);
    expect(mockItemDeleteMany).not.toHaveBeenCalled();
  });

  it("hard-deletes children then items, scoped to the workspace and the explicit id list", async () => {
    mockWorkspaceFindFirst.mockResolvedValue({ id: "ws-1" });
    // Both requested ids resolve inside ws-1, so the scoped list equals IDS.
    mockItemFindMany.mockResolvedValue(IDS.map((id) => ({ id })));
    mockVoteDeleteMany.mockResolvedValue({ count: 0 });
    mockAttachmentDeleteMany.mockResolvedValue({ count: 0 });
    mockItemDeleteMany.mockResolvedValue({ count: 2 });

    const res = await POST(
      request({ orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: IDS }, "test-migration-secret")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(2);
    expect(body.requested).toBe(2);
    expect(body.resolved).toBe(2);

    // Scope is resolved through FeedbackItem before anything is deleted.
    expect(mockItemFindMany).toHaveBeenCalledWith({
      where: { id: { in: IDS }, workspaceId: "ws-1" },
      select: { id: true },
    });

    // NOTE: these two assertions previously pinned the BUGGY shape — they
    // asserted the child deletes were keyed on the raw caller-supplied ids,
    // which is precisely the unscoped cross-workspace delete. They now assert
    // the workspace-resolved id list. Here the two happen to be equal because
    // every requested id is in scope; the mixed-workspace test below is what
    // distinguishes them.
    const RESOLVED = IDS;
    expect(mockVoteDeleteMany).toHaveBeenCalledWith({ where: { feedbackId: { in: RESOLVED } } });
    expect(mockAttachmentDeleteMany).toHaveBeenCalledWith({
      where: { feedbackItemId: { in: RESOLVED } },
    });

    // Items deleted ONLY when both the id is in the resolved list AND the row
    // belongs to the workspace — defense in depth on top of the resolve step.
    expect(mockItemDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: RESOLVED }, workspaceId: "ws-1" },
    });

    // Ordering: children before parents.
    const voteOrder = mockVoteDeleteMany.mock.invocationCallOrder[0];
    const attachmentOrder = mockAttachmentDeleteMany.mock.invocationCallOrder[0];
    const itemOrder = mockItemDeleteMany.mock.invocationCallOrder[0];
    expect(voteOrder).toBeLessThan(itemOrder);
    expect(attachmentOrder).toBeLessThan(itemOrder);
  });

  // Regression: FeedbackVote and FeedbackAttachment have no workspaceId column
  // of their own, so the ONLY way to scope a child delete to a workspace is to
  // resolve the parent ids through FeedbackItem first. Driving the child
  // deletes off the raw caller-supplied ids hard-deletes another workspace's
  // votes and attachments while reporting `deleted: 0`.
  it("deletes nothing when every requested id belongs to a different workspace", async () => {
    mockWorkspaceFindFirst.mockResolvedValue({ id: "ws-1" });
    mockItemFindMany.mockResolvedValue([]); // none of the ids live in ws-1
    mockVoteDeleteMany.mockResolvedValue({ count: 0 });
    mockAttachmentDeleteMany.mockResolvedValue({ count: 0 });
    mockItemDeleteMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      request(
        { orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: IDS },
        "test-migration-secret"
      )
    );

    // No delete of any kind may touch a foreign workspace's rows.
    expect(mockVoteDeleteMany).not.toHaveBeenCalled();
    expect(mockAttachmentDeleteMany).not.toHaveBeenCalled();
    expect(mockItemDeleteMany).not.toHaveBeenCalled();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(0);
    expect(body.requested).toBe(2);
    expect(body.resolved).toBe(0);
  });

  it("drives every delete off the in-scope ids when the list mixes workspaces", async () => {
    const IN_SCOPE = IDS[0];
    const FOREIGN = IDS[1];

    mockWorkspaceFindFirst.mockResolvedValue({ id: "ws-1" });
    mockItemFindMany.mockResolvedValue([{ id: IN_SCOPE }]);
    mockVoteDeleteMany.mockResolvedValue({ count: 0 });
    mockAttachmentDeleteMany.mockResolvedValue({ count: 0 });
    mockItemDeleteMany.mockResolvedValue({ count: 1 });

    const res = await POST(
      request(
        {
          orgSlug: "rbcodelabs",
          workspaceSlug: "hiptrip",
          feedbackIds: [IN_SCOPE, FOREIGN],
        },
        "test-migration-secret"
      )
    );

    // Children keyed on the RESOLVED ids only — the foreign id never appears.
    expect(mockVoteDeleteMany).toHaveBeenCalledWith({
      where: { feedbackId: { in: [IN_SCOPE] } },
    });
    expect(mockAttachmentDeleteMany).toHaveBeenCalledWith({
      where: { feedbackItemId: { in: [IN_SCOPE] } },
    });
    expect(mockItemDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: [IN_SCOPE] }, workspaceId: "ws-1" },
    });

    // The scope resolution happens once, before any delete.
    expect(mockItemFindMany).toHaveBeenCalledWith({
      where: { id: { in: [IN_SCOPE, FOREIGN] }, workspaceId: "ws-1" },
      select: { id: true },
    });
    const resolveOrder = mockItemFindMany.mock.invocationCallOrder[0];
    expect(resolveOrder).toBeLessThan(mockVoteDeleteMany.mock.invocationCallOrder[0]);
    expect(resolveOrder).toBeLessThan(mockAttachmentDeleteMany.mock.invocationCallOrder[0]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requested).toBe(2);
    expect(body.resolved).toBe(1);
    expect(body.deleted).toBe(1);
  });
});

// Attachment BLOBS: the rows above were always deleted; the files behind them were not (a permanent leak that also kept deleted
// feedback on public URLs). Design: Products/Compass/Runs/compass-attachment-leak-small-fix-design.md.
describe("POST /api/admin/purge-feedback: attachment blob release", () => {
  const WS_UUID = "11111111-1111-4111-8111-111111111111";
  const OTHER_WS_UUID = "22222222-2222-4222-8222-222222222222";
  const HOST = "store123.public.blob.vercel-storage.com";
  const OWN = `https://${HOST}/feedback/${WS_UUID}/1700000000000-own.png`;
  const THEIRS = `https://${HOST}/feedback/${OTHER_WS_UUID}/1700000000000-theirs.png`;

  beforeEach(() => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store123_secret");
    vi.stubEnv("COMPASS_ENV", "production");
    vi.stubEnv("FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED", "1");
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockWorkspaceFindFirst.mockResolvedValue({ id: WS_UUID });
    mockItemFindMany.mockResolvedValue(IDS.map((id) => ({ id })));
    mockVoteDeleteMany.mockResolvedValue({ count: 0 });
    mockAttachmentDeleteMany.mockResolvedValue({ count: 2 });
    mockItemDeleteMany.mockResolvedValue({ count: 2 });
    mockAttachmentFindMany.mockResolvedValue([{ url: OWN }, { url: THEIRS }]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const purge = () => POST(request({ orgSlug: "rbcodelabs", workspaceSlug: "hiptrip", feedbackIds: IDS }, "test-migration-secret"));

  it("deletes ONLY the purging workspace's own files, after the item delete, and reports blob counts", async () => {
    const res = await purge();
    expect(res.status).toBe(200);
    // URLs are read for the resolved (workspace-scoped) ids, before the rows are deleted.
    expect(mockAttachmentFindMany).toHaveBeenCalledWith({ where: { feedbackItemId: { in: IDS } }, select: { url: true } });
    expect(mockAttachmentFindMany.mock.invocationCallOrder[0]).toBeLessThan(mockAttachmentDeleteMany.mock.invocationCallOrder[0]);
    expect(mockStoreDelete.mock.calls).toEqual([[[OWN]]]);
    expect(mockStoreDelete.mock.invocationCallOrder[0]).toBeGreaterThan(mockItemDeleteMany.mock.invocationCallOrder[0]);
    const body = await res.json();
    expect(body).toMatchObject({ deleted: 2, resolved: 2, blobsDeleted: 1, blobsKept: 1, blobsDryRun: 0 });
  });

  it("deletes no file when the item delete fails (guard 3; mutation M3: release before the commit)", async () => {
    mockItemDeleteMany.mockRejectedValue(new Error("db down"));
    await expect(purge()).rejects.toThrow("db down");
    expect(mockStoreDelete).not.toHaveBeenCalled();
  });

  it("keeps a file another row still references", async () => {
    mockQueryRaw.mockResolvedValue([{ id: "other", url: OWN }]);
    const body = await (await purge()).json();
    expect(mockStoreDelete).not.toHaveBeenCalled();
    expect(body).toMatchObject({ blobsDeleted: 0, blobsKept: 2 });
  });

  it("with the flag off it only logs what it would delete", async () => {
    vi.stubEnv("FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED", "");
    const body = await (await purge()).json();
    expect(mockStoreDelete).not.toHaveBeenCalled();
    expect(body).toMatchObject({ blobsDeleted: 0, blobsDryRun: 1 });
  });

  it("a release failure never breaks the purge response", async () => {
    mockStoreDelete.mockRejectedValue(new Error("provider 500"));
    const res = await purge();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 2, blobsDeleted: 0 });
  });

  it("a failure while reading attachment URLs does not stop the purge", async () => {
    mockAttachmentFindMany.mockRejectedValue(new Error("read failed"));
    const res = await purge();
    expect(res.status).toBe(200);
    expect(mockItemDeleteMany).toHaveBeenCalled();
    expect(mockStoreDelete).not.toHaveBeenCalled();
  });
});
