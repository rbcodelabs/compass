import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The composer-facing discovery actions. Membership is checked with the real
 * lib/product-action-auth against a mocked session and workspace lookup; the
 * transactional write itself is covered in __tests__/lib/opportunity-create.
 */
const m = vi.hoisted(() => {
  const db = {
    workspace: { findFirst: vi.fn() },
    squad: { findFirst: vi.fn(), findMany: vi.fn() },
    keyResult: { findFirst: vi.fn(), findMany: vi.fn() },
    feedbackItem: { findMany: vi.fn(), updateMany: vi.fn() },
    opportunity: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, auth: vi.fn(), revalidatePath: vi.fn() };
});

vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/lib/db", () => ({ default: () => m.db }));

import {
  createOpportunityFromComposer,
  loadOpportunityComposerOptions,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1" } });
  m.db.workspace.findFirst.mockResolvedValue({ id: "ws-1" });
  m.db.$transaction.mockImplementation(async (callback: (tx: typeof m.db) => Promise<unknown>) => callback(m.db));
  m.db.opportunity.create.mockImplementation(async ({ data }: { data: { title: string } }) => ({ id: "opp-new", ...data }));
  m.db.squad.findFirst.mockResolvedValue({ id: "sq-1" });
  m.db.keyResult.findFirst.mockResolvedValue({ id: "kr-1" });
  m.db.feedbackItem.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id })),
  );
  m.db.feedbackItem.updateMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({
    count: where.id.in.length,
  }));
});

describe("createOpportunityFromComposer", () => {
  it("resolves the workspace by slug *and* membership before writing", async () => {
    await createOpportunityFromComposer("acme", "core", { title: "Onboarding" });
    expect(m.db.workspace.findFirst).toHaveBeenCalledWith({
      where: { slug: "core", organization: { slug: "acme" }, members: { some: { userId: "user-1" } } },
      select: { id: true },
    });
  });

  it("refuses a non-member without writing anything", async () => {
    m.db.workspace.findFirst.mockResolvedValue(null);
    const result = await createOpportunityFromComposer("acme", "core", { title: "Nope" });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Workspace not found/) });
    expect(m.db.$transaction).not.toHaveBeenCalled();
    expect(m.db.opportunity.create).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    m.auth.mockResolvedValue(null);
    const result = await createOpportunityFromComposer("acme", "core", { title: "Nope" });
    expect(result.ok).toBe(false);
    expect(m.db.opportunity.create).not.toHaveBeenCalled();
  });

  it("creates the opportunity with its KR and feedback links, scoped to the member's workspace", async () => {
    const result = await createOpportunityFromComposer("acme", "core", {
      title: "  Onboarding stalls ",
      description: "## Who's affected",
      status: "PRIORITIZED",
      squadId: "sq-1",
      linkedKeyResultId: "kr-1",
      feedbackIds: ["fb-1", "fb-2"],
    });
    expect(result).toEqual({ ok: true, opportunity: { id: "opp-new", title: "Onboarding stalls" } });
    expect(m.db.$transaction).toHaveBeenCalledOnce();
    expect(m.db.keyResult.findFirst).toHaveBeenCalledWith({
      where: { id: "kr-1", objective: { cycle: { workspaceId: "ws-1" } } },
      select: { id: true },
    });
    expect(m.db.opportunity.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws-1",
      title: "Onboarding stalls",
      status: "PRIORITIZED",
      squadId: "sq-1",
      linkedKeyResultId: "kr-1",
    });
    expect(m.db.feedbackItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["fb-1", "fb-2"] }, workspaceId: "ws-1" },
      data: { opportunityId: "opp-new", updatedAt: expect.any(Date) },
    });
    // The rail lives in the discovery layout; linked feedback moves in the grid.
    expect(m.revalidatePath).toHaveBeenCalledWith("/[orgSlug]/[workspaceSlug]/discovery", "layout");
    expect(m.revalidatePath).toHaveBeenCalledWith("/acme/core/feedback");
  });

  it("returns a KR from another workspace as an inline error and creates nothing", async () => {
    m.db.keyResult.findFirst.mockResolvedValue(null);
    const result = await createOpportunityFromComposer("acme", "core", { title: "x", linkedKeyResultId: "kr-foreign" });
    expect(result).toEqual({ ok: false, error: "That key result is not in this workspace." });
    expect(m.db.opportunity.create).not.toHaveBeenCalled();
  });

  it("returns foreign feedback as an inline error and creates nothing", async () => {
    m.db.feedbackItem.findMany.mockResolvedValue([{ id: "fb-1" }]);
    const result = await createOpportunityFromComposer("acme", "core", { title: "x", feedbackIds: ["fb-1", "fb-foreign"] });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/feedback items are not in this workspace/) });
    expect(m.db.opportunity.create).not.toHaveBeenCalled();
    expect(m.db.feedbackItem.updateMany).not.toHaveBeenCalled();
  });

  it("returns an empty title as an inline error without opening a transaction", async () => {
    const result = await createOpportunityFromComposer("acme", "core", { title: "   " });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Add a title/) });
    expect(m.db.$transaction).not.toHaveBeenCalled();
  });

  it("lets an unexpected database failure surface to the caller", async () => {
    m.db.opportunity.create.mockRejectedValue(new Error("DB down"));
    await expect(createOpportunityFromComposer("acme", "core", { title: "x" })).rejects.toThrow("DB down");
  });
});

describe("loadOpportunityComposerOptions", () => {
  it("refuses a non-member", async () => {
    m.db.workspace.findFirst.mockResolvedValue(null);
    const result = await loadOpportunityComposerOptions("acme", "core");
    expect(result.ok).toBe(false);
    expect(m.db.keyResult.findMany).not.toHaveBeenCalled();
  });

  it("returns the workspace's squads, KRs (with objective) and recent feedback", async () => {
    m.db.squad.findMany.mockResolvedValue([{ id: "sq-1", name: "Growth", color: "#f00" }]);
    m.db.keyResult.findMany.mockResolvedValue([{ id: "kr-1", title: "Activation 40%", objective: { title: "Grow" } }]);
    m.db.feedbackItem.findMany.mockResolvedValue([
      { id: "fb-1", title: "Slow", type: "BUG", status: "OPEN", opportunity: null },
    ]);
    const result = await loadOpportunityComposerOptions("acme", "core");
    expect(result).toEqual({
      ok: true,
      options: {
        squads: [{ id: "sq-1", name: "Growth", color: "#f00" }],
        keyResults: [{ id: "kr-1", title: "Activation 40%", objectiveTitle: "Grow" }],
        feedback: [{ id: "fb-1", title: "Slow", type: "BUG", status: "OPEN", opportunity: null }],
      },
    });
    expect(m.db.keyResult.findMany.mock.calls[0][0].where).toEqual({ objective: { cycle: { workspaceId: "ws-1" } } });
    expect(m.db.feedbackItem.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1" });
  });
});
