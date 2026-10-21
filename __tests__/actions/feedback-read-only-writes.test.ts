/**
 * Cross-tenant regression matrix for the feedback mutations.
 *
 * A server action is a public POST endpoint, so "signed in" is not enough: the
 * caller must be a member of the workspace named by the slugs, and every ID the
 * caller sends must belong to that workspace. Runs against an in-memory tenant
 * fixture that honours the `where` clauses (see helpers/tenant-fake-prisma), so
 * a missing filter shows up as a real change to the other tenant's rows.
 */
/**
 * Read-only members (org-wide `memberWorkspaceReadOnlyAccess`, no
 * WorkspaceMember row) must not be able to write feedback by calling the server
 * actions directly. The grid only hides the controls; the actions must refuse.
 * Uses the real workspace-context resolver against the tenant fixture, where
 * `frank` is a read-only org member of workspace A.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({
  auth: async () =>
    session.userId
      ? { user: { id: session.userId, name: "Test", email: "t@example.com", image: null } }
      : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/feedback-attachments", () => ({
  verifyCompletedFeedbackUpload: vi.fn(),
  verifyFeedbackUploadOwnership: vi.fn(),
  prepareFeedbackAttachmentUpload: vi.fn(),
  deleteFeedbackBlobs: vi.fn(),
}));

import {
  createFeedback,
  discardFeedbackAttachment,
  linkFeedbackToOpportunity,
  prepareFeedbackAttachment,
  updateFeedbackStatus,
  updateFeedbackType,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import { requireWorkspaceContextOrThrow } from "@/lib/workspace-context";

const READ_ONLY_ERROR = "Forbidden: workspace is read-only";

const updates = [
  {
    name: "updateFeedbackStatus",
    run: () => updateFeedbackStatus(WS_A.org, WS_A.slug, "fb-a", "CLOSED", null),
  },
  {
    name: "updateFeedbackType",
    run: () => updateFeedbackType(WS_A.org, WS_A.slug, "fb-a", "BUG", null),
  },
  {
    name: "linkFeedbackToOpportunity",
    run: () => linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-a", "opp-a", null),
  },
  {
    name: "linkFeedbackToOpportunity (clear link)",
    run: () => linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-a", null, null),
  },
] as const;

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  session.userId = null;
});

describe.each(updates)("$name with a read-only org member", ({ run }) => {
  it("is rejected with the read-only failure and writes nothing", async () => {
    session.userId = USERS.frank;
    const before = fake.current!.snapshotFeedback();
    expect(await run()).toEqual({ ok: false, error: READ_ONLY_ERROR });
    expect(fake.current!.snapshotFeedback()).toEqual(before);
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("still succeeds for a real workspace member (control)", async () => {
    session.userId = USERS.alice;
    expect(await run()).toEqual({ ok: true });
  });
});

describe("other feedback writes with a read-only org member", () => {
  it("createFeedback is rejected", async () => {
    session.userId = USERS.frank;
    const result = await createFeedback(
      WS_A.org,
      WS_A.slug,
      { title: "Sneaky", description: "d", type: "IDEA" },
      "/x"
    );
    expect(result.ok).toBe(false);
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("prepareFeedbackAttachment is rejected", async () => {
    session.userId = USERS.frank;
    const result = await prepareFeedbackAttachment(WS_A.org, WS_A.slug, {
      filename: "a.png",
      fileType: "image/png",
      fileSize: 100,
    });
    expect(result.ok).toBe(false);
  });

  it("discardFeedbackAttachment is rejected", async () => {
    session.userId = USERS.frank;
    const result = await discardFeedbackAttachment(WS_A.org, WS_A.slug, { url: "https://x/y", receipt: "r" });
    expect(result.ok).toBe(false);
  });
});

describe("read paths are unaffected", () => {
  it("the context resolver still resolves a read-only member (flagged read-only) so pages render", async () => {
    session.userId = USERS.frank;
    const context = await requireWorkspaceContextOrThrow(WS_A.org, WS_A.slug);
    expect(context.workspace.id).toBe(WS_A.id);
    expect(context.isReadOnly).toBe(true);
  });
});
