/**
 * Unit tests for lib/entity-mutations.ts.
 *
 * Prisma is mocked. The important behaviors: field/value validation against
 * EDIT_CONFIG, and that the write is workspace-scoped — the entity is verified
 * present in the workspace (via the scoped findFirst) BEFORE any update, so a
 * cross-workspace edit can't slip through (the write-side IDOR guard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const models = {
  objective: { findFirst: vi.fn(), update: vi.fn() },
  keyResult: { findFirst: vi.fn(), update: vi.fn() },
  opportunity: { findFirst: vi.fn(), update: vi.fn() },
  solution: { findFirst: vi.fn(), update: vi.fn() },
  feedbackItem: { findFirst: vi.fn(), update: vi.fn() },
  roadmapItem: { findFirst: vi.fn(), update: vi.fn() },
};

vi.mock("@/lib/db", () => ({ default: () => models }));

import { updateEntityField, EDIT_CONFIG, TITLE_MAX_LENGTH } from "@/lib/entity-mutations";

const WS = "ws-1";

beforeEach(() => {
  vi.clearAllMocks();
  // default: entity is in the workspace
  for (const m of Object.values(models)) m.findFirst.mockResolvedValue({ id: "e1" });
});

describe("EDIT_CONFIG", () => {
  it("marks keyResult as having no editable enum (no status field)", () => {
    expect(EDIT_CONFIG.keyResult.enum).toBeUndefined();
  });
  it("uses horizon (not status) as the roadmap item's enum field", () => {
    expect(EDIT_CONFIG.roadmapItem.enum?.field).toBe("horizon");
  });
});

describe("updateEntityField — validation", () => {
  it("rejects an empty title", async () => {
    const r = await updateEntityField("objective", "e1", WS, "title", "   ");
    expect(r).toEqual({ ok: false, status: 400, error: "Title is required" });
    expect(models.objective.update).not.toHaveBeenCalled();
  });

  it("rejects an over-long title", async () => {
    const r = await updateEntityField("objective", "e1", WS, "title", "a".repeat(TITLE_MAX_LENGTH + 1));
    expect(r.ok).toBe(false);
    expect(models.objective.update).not.toHaveBeenCalled();
  });

  it("trims and saves a valid title, always setting updatedAt", async () => {
    const r = await updateEntityField("opportunity", "e1", WS, "title", "  Hello  ");
    expect(r).toEqual({ ok: true });
    const arg = models.opportunity.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "e1" });
    expect(arg.data.title).toBe("Hello");
    expect(arg.data.updatedAt).toBeInstanceOf(Date);
  });

  it("normalizes an empty description to null", async () => {
    await updateEntityField("solution", "e1", WS, "description", "   ");
    expect(models.solution.update.mock.calls[0][0].data.description).toBeNull();
  });

  it("rejects description on an entity that doesn't support it (keyResult)", async () => {
    const r = await updateEntityField("keyResult", "e1", WS, "description", "x");
    expect(r).toEqual({ ok: false, status: 400, error: "Description is not editable" });
  });

  it("rejects an invalid status enum value", async () => {
    const r = await updateEntityField("objective", "e1", WS, "status", "BOGUS");
    expect(r).toEqual({ ok: false, status: 400, error: "Invalid status" });
    expect(models.objective.update).not.toHaveBeenCalled();
  });

  it("accepts a valid status enum value", async () => {
    const r = await updateEntityField("feedback", "e1", WS, "status", "PLANNED");
    expect(r).toEqual({ ok: true });
    expect(models.feedbackItem.update.mock.calls[0][0].data.status).toBe("PLANNED");
  });

  it("accepts horizon for roadmap items but rejects 'status' there", async () => {
    expect((await updateEntityField("roadmapItem", "e1", WS, "horizon", "NEXT")).ok).toBe(true);
    const r = await updateEntityField("roadmapItem", "e1", WS, "status", "ACTIVE");
    expect(r.ok).toBe(false);
  });

  it("rejects an entirely unknown field", async () => {
    const r = await updateEntityField("opportunity", "e1", WS, "workspaceId", "other-ws");
    expect(r).toEqual({ ok: false, status: 400, error: 'Field "workspaceId" is not editable' });
    expect(models.opportunity.update).not.toHaveBeenCalled();
  });
});

describe("updateEntityField — workspace scoping (write-side IDOR guard)", () => {
  it("404s and never updates when the entity isn't in the workspace", async () => {
    models.opportunity.findFirst.mockResolvedValue(null);
    const r = await updateEntityField("opportunity", "e1", WS, "title", "New");
    expect(r).toEqual({ ok: false, status: 404, error: "Not found" });
    expect(models.opportunity.update).not.toHaveBeenCalled();
  });

  it("verifies with the parent-chain scope for indirect entities before updating", async () => {
    await updateEntityField("solution", "sol-1", WS, "title", "New");
    expect(models.solution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "sol-1", opportunity: { workspaceId: WS } } })
    );
    expect(models.solution.update).toHaveBeenCalled();
  });
});
