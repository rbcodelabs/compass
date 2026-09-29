/**
 * Cross-tenant regression matrix for the feedback mutations.
 *
 * A server action is a public POST endpoint, so "signed in" is not enough: the
 * caller must be a member of the workspace named by the slugs, and every ID the
 * caller sends must belong to that workspace. Runs against an in-memory tenant
 * fixture that honours the `where` clauses (see helpers/tenant-fake-prisma), so
 * a missing filter shows up as a real change to the other tenant's rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

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
  linkFeedbackToOpportunity,
  updateFeedbackStatus,
  updateFeedbackType,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";

type Row = ReturnType<typeof createTenantFakePrisma>["state"]["feedback"][number];

const fb = (id: string): Row => fake.current!.state.feedback.find((row) => row.id === id)!;

/** The three mutations, each driven with the same (orgSlug, workspaceSlug, feedbackId) triple. */
const mutations = [
  {
    name: "updateFeedbackStatus",
    run: (org: string, ws: string, id: string) => updateFeedbackStatus(org, ws, id, "CLOSED", null),
    changed: (row: Row) => row.status === "CLOSED",
  },
  {
    name: "updateFeedbackType",
    run: (org: string, ws: string, id: string) => updateFeedbackType(org, ws, id, "BUG", null),
    changed: (row: Row) => row.type === "BUG",
  },
  {
    name: "linkFeedbackToOpportunity (own-workspace opportunity)",
    run: (org: string, ws: string, id: string) =>
      linkFeedbackToOpportunity(org, ws, id, id === "fb-b" ? "opp-b" : "opp-a", null),
    changed: (row: Row) => row.opportunityId !== null,
  },
] as const;

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  session.userId = null;
});

describe.each(mutations)("$name", ({ run, changed }) => {
  it("updates a feedback item in the caller's own workspace (control)", async () => {
    session.userId = USERS.alice;
    const result = await run(WS_A.org, WS_A.slug, "fb-a");
    expect(result).toEqual({ ok: true });
    expect(changed(fb("fb-a"))).toBe(true);
  });

  it("refuses an unauthenticated caller", async () => {
    const before = fake.current!.snapshotFeedback();
    const result = await run(WS_B.org, WS_B.slug, "fb-b");
    expect(result.ok).toBe(false);
    expect(fake.current!.snapshotFeedback()).toEqual(before);
  });

  it("refuses a signed-in non-member sending workspace B's slugs and IDs", async () => {
    session.userId = USERS.eve;
    const before = fake.current!.snapshotFeedback();
    const result = await run(WS_B.org, WS_B.slug, "fb-b");
    expect(result.ok).toBe(false);
    expect(fake.current!.snapshotFeedback()).toEqual(before);
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("refuses a member of A who sends workspace B's slugs and IDs", async () => {
    session.userId = USERS.alice;
    const before = fake.current!.snapshotFeedback();
    const result = await run(WS_B.org, WS_B.slug, "fb-b");
    expect(result.ok).toBe(false);
    expect(fake.current!.snapshotFeedback()).toEqual(before);
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("refuses a member of A who sends B's feedback ID under A's slugs", async () => {
    session.userId = USERS.alice;
    const before = fake.current!.snapshotFeedback();
    const result = await run(WS_A.org, WS_A.slug, "fb-b");
    expect(result.ok).toBe(false);
    expect(fb("fb-b")).toEqual((before as Row[]).find((row) => row.id === "fb-b"));
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("does not mutate when the feedback ID does not exist", async () => {
    session.userId = USERS.alice;
    const result = await run(WS_A.org, WS_A.slug, "fb-missing");
    expect(result.ok).toBe(false);
    expect(fake.current!.state.writes).toEqual([]);
  });
});

describe("linkFeedbackToOpportunity opportunity binding", () => {
  it("refuses to link A's feedback to an opportunity that belongs to B", async () => {
    session.userId = USERS.alice;
    const result = await linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-a", "opp-b", null);
    expect(result.ok).toBe(false);
    expect(fb("fb-a").opportunityId).toBeNull();
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("refuses to link to an opportunity that does not exist", async () => {
    session.userId = USERS.alice;
    const result = await linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-a", "opp-missing", null);
    expect(result.ok).toBe(false);
    expect(fb("fb-a").opportunityId).toBeNull();
  });

  it("links to an opportunity in the same workspace", async () => {
    session.userId = USERS.alice;
    const result = await linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-a", "opp-a", null);
    expect(result).toEqual({ ok: true });
    expect(fb("fb-a").opportunityId).toBe("opp-a");
  });

  it("still allows clearing a link (null opportunity)", async () => {
    session.userId = USERS.alice;
    fb("fb-a").opportunityId = "opp-a";
    const result = await linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-a", null, null);
    expect(result).toEqual({ ok: true });
    expect(fb("fb-a").opportunityId).toBeNull();
  });

  it("does not clear B's link when a member of A targets B's feedback", async () => {
    session.userId = USERS.alice;
    fb("fb-b").opportunityId = "opp-b";
    const result = await linkFeedbackToOpportunity(WS_A.org, WS_A.slug, "fb-b", null, null);
    expect(result.ok).toBe(false);
    expect(fb("fb-b").opportunityId).toBe("opp-b");
  });
});
