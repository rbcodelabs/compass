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
 * workspace AND a non-empty explicit id list, and every delete is scoped to
 * `{ id: { in: ids }, workspaceId }`. It can never mass-delete a workspace's
 * feedback, and it can never delete another workspace's rows even if their
 * ids are passed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockWorkspaceFindFirst = vi.fn();
const mockVoteDeleteMany = vi.fn();
const mockAttachmentDeleteMany = vi.fn();
const mockItemDeleteMany = vi.fn();

const mockPrisma = {
  workspace: { findFirst: mockWorkspaceFindFirst },
  feedbackVote: { deleteMany: mockVoteDeleteMany },
  feedbackAttachment: { deleteMany: mockAttachmentDeleteMany },
  feedbackItem: { deleteMany: mockItemDeleteMany },
};

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
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

    // Children deleted by the item-id relation columns.
    expect(mockVoteDeleteMany).toHaveBeenCalledWith({ where: { feedbackId: { in: IDS } } });
    expect(mockAttachmentDeleteMany).toHaveBeenCalledWith({
      where: { feedbackItemId: { in: IDS } },
    });

    // Items deleted ONLY when both the id is in the list AND the row belongs to
    // the resolved workspace — this is the cross-workspace / mass-delete guard.
    expect(mockItemDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: IDS }, workspaceId: "ws-1" },
    });

    // Ordering: children before parents.
    const voteOrder = mockVoteDeleteMany.mock.invocationCallOrder[0];
    const attachmentOrder = mockAttachmentDeleteMany.mock.invocationCallOrder[0];
    const itemOrder = mockItemDeleteMany.mock.invocationCallOrder[0];
    expect(voteOrder).toBeLessThan(itemOrder);
    expect(attachmentOrder).toBeLessThan(itemOrder);
  });
});
