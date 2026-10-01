import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The composer-facing discovery actions. Membership is checked with the real
 * lib/product-action-auth against a mocked session and workspace lookup; the
 * transactional write itself is covered in __tests__/lib/opportunity-create.
 */
const m = vi.hoisted(() => {
  const db = {
    workspace: { findFirst: vi.fn(), findUnique: vi.fn() },
    squad: { findFirst: vi.fn(), findMany: vi.fn() },
    keyResult: { findFirst: vi.fn(), findMany: vi.fn() },
    objective: { findFirst: vi.fn(), findMany: vi.fn() },
    feedbackItem: { findMany: vi.fn(), updateMany: vi.fn() },
    opportunity: { create: vi.fn(), findFirst: vi.fn() },
    opportunityObjectiveLink: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
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
  m.db.workspace.findUnique.mockResolvedValue({ thinkingModel: null, thinkingModelLabels: null });
  m.db.objective.findMany.mockResolvedValue([]);
  m.db.objective.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, workspaceId: "ws-1", title: where.id }));
  m.db.opportunity.findFirst.mockResolvedValue({ id: "opp-new", workspaceId: "ws-1", title: "x", linkedKeyResultId: null });
  m.db.$transaction.mockImplementation(async (callback: (tx: typeof m.db) => Promise<unknown>) => callback(m.db));
  m.db.opportunity.create.mockImplementation(async ({ data }: { data: { title: string } }) => ({ id: "opp-new", ...data }));
  m.db.squad.findFirst.mockResolvedValue({ id: "sq-1" });
  m.db.keyResult.findFirst.mockResolvedValue({ id: "kr-1", title: "KR", objectiveId: "obj-1", objective: { workspaceId: "ws-1" } });
  m.db.opportunityObjectiveLink.findFirst.mockResolvedValue(null);
  m.db.opportunityObjectiveLink.create.mockResolvedValue({ id: "link-1" });
  m.db.opportunityObjectiveLink.deleteMany.mockResolvedValue({ count: 0 });
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
      where: { id: "kr-1", objective: { workspaceId: "ws-1" } },
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
    // The legacy pointer's LEGACY link is written in that same transaction.
    expect(m.db.opportunityObjectiveLink.create).toHaveBeenCalledWith({
      data: { workspaceId: "ws-1", opportunityId: "opp-new", objectiveId: "obj-1", origin: "LEGACY", source: "UI", createdById: null },
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

  it("says the Key Result message in the workspace's own words (Torres, or a rename)", async () => {
    m.db.keyResult.findFirst.mockResolvedValue(null);
    m.db.workspace.findUnique.mockResolvedValue({ thinkingModel: "TORRES_OST", thinkingModelLabels: null });
    const torres = await createOpportunityFromComposer("acme", "core", { title: "x", linkedKeyResultId: "kr-foreign" });
    expect(torres).toEqual({ ok: false, error: "That success metric is not in this workspace." });
    m.db.workspace.findUnique.mockResolvedValue({ thinkingModel: "CLASSIC", thinkingModelLabels: JSON.stringify({ keyResult: { singular: "Signal" } }) });
    const renamed = await createOpportunityFromComposer("acme", "core", { title: "x", linkedKeyResultId: "kr-foreign" });
    expect(renamed).toEqual({ ok: false, error: "That signal is not in this workspace." });
    expect(m.db.opportunity.create).not.toHaveBeenCalled();
  });

  it("falls back to the canonical wording when the workspace's names cannot be read", async () => {
    m.db.keyResult.findFirst.mockResolvedValue(null);
    m.db.workspace.findUnique.mockRejectedValue(new Error("column thinking_model does not exist"));
    const result = await createOpportunityFromComposer("acme", "core", { title: "x", linkedKeyResultId: "kr-foreign" });
    expect(result).toEqual({ ok: false, error: "That key result is not in this workspace." });
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

  describe("chosen objectives (Phase 4B)", () => {
    it("links them DIRECT in the same transaction, attributed to the signed-in user, with the workspace taken from the opportunity", async () => {
      m.db.objective.findMany.mockResolvedValue([{ id: "obj-1" }, { id: "obj-2" }]);
      const result = await createOpportunityFromComposer("acme", "core", { title: "Onboarding", objectiveIds: ["obj-1", "obj-2"] });
      expect(result).toEqual({ ok: true, opportunity: { id: "opp-new", title: "Onboarding" } });
      expect(m.db.$transaction).toHaveBeenCalledOnce();
      expect(m.db.objective.findMany).toHaveBeenCalledWith({ where: { id: { in: ["obj-1", "obj-2"] }, workspaceId: "ws-1" }, select: { id: true } });
      expect(m.db.opportunityObjectiveLink.create.mock.calls.map((c) => c[0].data)).toEqual([
        { workspaceId: "ws-1", opportunityId: "opp-new", objectiveId: "obj-1", origin: "DIRECT", source: "UI", createdById: "user-1" },
        { workspaceId: "ws-1", opportunityId: "opp-new", objectiveId: "obj-2", origin: "DIRECT", source: "UI", createdById: "user-1" },
      ]);
      expect(m.revalidatePath).toHaveBeenCalledWith("/acme/core/okrs");
    });

    it("creates nothing for an objective outside the workspace, and says so inline", async () => {
      m.db.objective.findMany.mockResolvedValue([{ id: "obj-1" }]);
      const result = await createOpportunityFromComposer("acme", "core", { title: "x", objectiveIds: ["obj-1", "obj-foreign"] });
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/not in this workspace/) });
      expect(m.db.opportunity.create).not.toHaveBeenCalled();
      expect(m.db.opportunityObjectiveLink.create).not.toHaveBeenCalled();
    });

    it("a missing link table FAILS the create with a generic message and logs only the error name and code", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      m.db.objective.findMany.mockResolvedValue([{ id: "obj-1" }]);
      m.db.opportunityObjectiveLink.findFirst.mockRejectedValue(
        Object.assign(new Error('relation "opportunity_objective_links" does not exist SECRET-ROW'), { name: "PrismaClientKnownRequestError", code: "42P01" }),
      );
      const result = await createOpportunityFromComposer("acme", "core", { title: "x", objectiveIds: ["obj-1"] });
      expect(result).toEqual({ ok: false, error: "Something went wrong. Nothing was created. Please try again." });
      const text = JSON.stringify(logged.mock.calls);
      expect(text).toContain("42P01");
      expect(text).toContain("PrismaClientKnownRequestError");
      expect(text).not.toContain("SECRET-ROW");
      logged.mockRestore();
    });

    it("without objectives it is the same create as before: no attribution lookup, no objective query, no okrs revalidation", async () => {
      await createOpportunityFromComposer("acme", "core", { title: "Plain" });
      expect(m.db.objective.findMany).not.toHaveBeenCalled();
      expect(m.revalidatePath).not.toHaveBeenCalledWith("/acme/core/okrs");
    });
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
    expect(m.db.keyResult.findMany.mock.calls[0][0].where).toEqual({ objective: { workspaceId: "ws-1" } });
    expect(m.db.feedbackItem.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1" });
    // CLASSIC: no objectives query and no new key in the payload.
    expect(m.db.objective.findMany).not.toHaveBeenCalled();
  });

  it.each(["TORRES_OST", "OPPORTUNITY_FIRST_OKR"])("%s: also offers the workspace's objectives, filtered on the objective's own workspaceId", async (preset) => {
    m.db.workspace.findUnique.mockResolvedValue({ thinkingModel: preset, thinkingModelLabels: null });
    m.db.squad.findMany.mockResolvedValue([]);
    m.db.keyResult.findMany.mockResolvedValue([]);
    m.db.feedbackItem.findMany.mockResolvedValue([]);
    m.db.objective.findMany.mockResolvedValue([{ id: "obj-1", title: "Grow", cycle: { title: "Q3" } }, { id: "obj-2", title: "Cut", cycle: null }]);
    const result = await loadOpportunityComposerOptions("acme", "core");
    expect(result.ok && result.options.objectives).toEqual([
      { id: "obj-1", title: "Grow", cycleTitle: "Q3" },
      { id: "obj-2", title: "Cut", cycleTitle: null },
    ]);
    expect(m.db.objective.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws-1" });
  });
});
