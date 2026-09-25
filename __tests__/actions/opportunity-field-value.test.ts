import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireProductEntity: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  opportunityUpdate: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/product-action-auth", () => ({
  requireProductWorkspace: vi.fn(),
  requireProductEntity: m.requireProductEntity,
}));
vi.mock("@/lib/db", () => ({
  default: vi.fn(() => ({
    customFieldDefinition: { findFirst: m.findFirst },
    customFieldValue: { upsert: m.upsert, deleteMany: m.deleteMany },
    opportunity: { update: m.opportunityUpdate },
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));

import { setOpportunityFieldValue } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

const moscowRow = {
  id: "moscow",
  name: "MoSCoW",
  fieldType: "SELECT",
  objectType: "OPPORTUNITY",
  options: [{ label: "Must", value: "must" }, { label: "Should", value: "should" }],
  sharedOptionSetId: null,
  required: false,
  order: 0,
  sharedOptionSet: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requireProductEntity.mockResolvedValue({ workspaceId: "ws-1", opportunityId: null });
  m.findFirst.mockResolvedValue(moscowRow);
});

function expectNoWrites() {
  expect(m.upsert).not.toHaveBeenCalled();
  expect(m.deleteMany).not.toHaveBeenCalled();
  expect(m.opportunityUpdate).not.toHaveBeenCalled();
}

describe("setOpportunityFieldValue", () => {
  it("sets an effective option on an opportunity in the caller's workspace and nothing else", async () => {
    await expect(setOpportunityFieldValue("opp-1", "moscow", "should", "ws-1", "/acme/core/discovery")).resolves.toEqual({ value: "should" });

    expect(m.requireProductEntity).toHaveBeenCalledWith("opportunity", "opp-1", "ws-1");
    // The field is looked up inside the opportunity's workspace, never by bare id.
    expect(m.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "moscow", workspaceId: "ws-1" } }));
    expect(m.upsert).toHaveBeenCalledWith({
      where: { fieldId_objectId: { fieldId: "moscow", objectId: "opp-1" } },
      create: { fieldId: "moscow", objectId: "opp-1", value: "should" },
      update: { value: "should", updatedAt: expect.any(Date) },
    });
    // Card sorting never touches status, sortOrder or archive state.
    expect(m.opportunityUpdate).not.toHaveBeenCalled();
    expect(m.revalidatePath).toHaveBeenCalledWith("/acme/core/discovery");
  });

  it("accepts options that come from a shared option set", async () => {
    m.findFirst.mockResolvedValue({
      ...moscowRow,
      options: null,
      sharedOptionSetId: "set-1",
      sharedOptionSet: { id: "set-1", name: "Priority", options: [{ label: "Won't", value: "wont" }] },
    });
    await expect(setOpportunityFieldValue("opp-1", "moscow", "wont", "ws-1", "/")).resolves.toEqual({ value: "wont" });
    expect(m.upsert).toHaveBeenCalled();
  });

  it("clears the value when moved to Unspecified", async () => {
    await expect(setOpportunityFieldValue("opp-1", "moscow", null, "ws-1", "/")).resolves.toEqual({ value: null });
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { fieldId: "moscow", objectId: "opp-1" } });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("rejects an opportunity outside the caller's workspace", async () => {
    m.requireProductEntity.mockRejectedValue(new Error("Entity not found or access denied"));
    await expect(setOpportunityFieldValue("opp-other", "moscow", "must", "ws-1", "/")).rejects.toThrow("access denied");
    expect(m.findFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("rejects a field that belongs to another workspace", async () => {
    m.findFirst.mockResolvedValue(null);
    await expect(setOpportunityFieldValue("opp-1", "foreign-field", "must", "ws-1", "/")).rejects.toThrow("Field not found");
    expectNoWrites();
  });

  it.each([
    ["a multi-select field", { fieldType: "MULTI_SELECT" }, "must", /single-select/],
    ["a text field", { fieldType: "TEXT", options: null }, "must", /single-select/],
    ["a Solution field", { objectType: "SOLUTION" }, "must", /Opportunity field/],
    ["an option that is not defined", {}, "could", /no longer exists/],
  ])("rejects %s", async (_name, override, value, message) => {
    m.findFirst.mockResolvedValue({ ...moscowRow, ...override });
    await expect(setOpportunityFieldValue("opp-1", "moscow", value, "ws-1", "/")).rejects.toThrow(message);
    expectNoWrites();
  });

  it("requires a signed-in user", async () => {
    m.requireProductEntity.mockRejectedValue(new Error("Unauthorized"));
    await expect(setOpportunityFieldValue("opp-1", "moscow", "must", "ws-1", "/")).rejects.toThrow("Unauthorized");
    expectNoWrites();
  });
});
