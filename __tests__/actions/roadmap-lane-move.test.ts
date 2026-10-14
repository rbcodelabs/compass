import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

const roadmapItem = { findFirst: vi.fn(), update: vi.fn() };
const workspaceMember = { findUnique: vi.fn() };
const squad = { findFirst: vi.fn() };
const customFieldDefinition = { findFirst: vi.fn() };
const customFieldValue = { upsert: vi.fn(), deleteMany: vi.fn() };

const prisma = {
  roadmapItem,
  workspaceMember,
  squad,
  customFieldDefinition,
  customFieldValue,
  $transaction: vi.fn(),
};

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ default: () => prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import { moveItemToLane } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";

const WS = "workspace-a";
const ITEM = "item-a";

const selectField = {
  id: "field-a",
  workspaceId: WS,
  name: "Team",
  objectType: "ROADMAP_ITEM",
  fieldType: "SELECT",
  options: [
    { label: "Red", value: "red" },
    { label: "Blue", value: "blue" },
  ],
  sharedOptionSetId: null,
  sharedOptionSet: null,
  required: false,
  order: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-a" } });
  workspaceMember.findUnique.mockResolvedValue({ id: "member-a" });
  roadmapItem.findFirst.mockImplementation(({ where }: { where: { id?: string } }) =>
    Promise.resolve(where.id ? { id: where.id, horizon: "NEXT", status: "ACTIVE", sortOrder: 0 } : null),
  );
  roadmapItem.update.mockImplementation(({ data }: { data: { squadId: string | null } }) =>
    Promise.resolve({ id: ITEM, squadId: data.squadId }),
  );
  squad.findFirst.mockResolvedValue({ id: "squad-a" });
  customFieldDefinition.findFirst.mockResolvedValue(selectField);
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => callback(prisma));
});

describe("moveItemToLane authorization", () => {
  it("rejects an unauthenticated caller before any database access", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(moveItemToLane(ITEM, WS, { kind: "squad", squadId: "squad-a" })).rejects.toThrow("Unauthorized");
    expect(workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["squad", { kind: "squad", squadId: "squad-a" }],
    ["customField", { kind: "customField", fieldId: "field-a", value: "red" }],
  ] as const)("rejects a non-member %s move without writing", async (_name, assignment) => {
    workspaceMember.findUnique.mockResolvedValue(null);
    await expect(moveItemToLane(ITEM, WS, assignment)).rejects.toThrow("Workspace not found");
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(customFieldValue.upsert).not.toHaveBeenCalled();
    expect(customFieldValue.deleteMany).not.toHaveBeenCalled();
  });

  it("scopes the item lookup to the authorized workspace and rejects a foreign item", async () => {
    roadmapItem.findFirst.mockResolvedValueOnce(null);
    await expect(moveItemToLane(ITEM, WS, { kind: "squad", squadId: "squad-a" })).rejects.toThrow("Roadmap item not found");
    expect(roadmapItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ITEM, workspaceId: WS } }));
    expect(roadmapItem.update).not.toHaveBeenCalled();
  });

  it("rejects an archived item", async () => {
    roadmapItem.findFirst.mockResolvedValueOnce({ id: ITEM, horizon: "NEXT", status: "ARCHIVED", sortOrder: 0 });
    await expect(moveItemToLane(ITEM, WS, { kind: "squad", squadId: "squad-a" })).rejects.toThrow("Roadmap item not found");
    expect(roadmapItem.update).not.toHaveBeenCalled();
  });
});

describe("moveItemToLane squad lanes", () => {
  it("sets the squad after verifying it belongs to the workspace", async () => {
    const result = await moveItemToLane(ITEM, WS, { kind: "squad", squadId: "squad-a" });
    expect(squad.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "squad-a", workspaceId: WS } }));
    expect(roadmapItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM }, data: expect.objectContaining({ squadId: "squad-a" }) }),
    );
    expect(result).toMatchObject({ id: ITEM, squadId: "squad-a" });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("clears the squad for the Unassigned lane without a squad lookup", async () => {
    const result = await moveItemToLane(ITEM, WS, { kind: "squad", squadId: null });
    expect(squad.findFirst).not.toHaveBeenCalled();
    expect(roadmapItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ squadId: null }) }),
    );
    expect(result.squadId).toBeNull();
  });

  it("rejects a squad from another workspace before writing", async () => {
    squad.findFirst.mockResolvedValueOnce(null);
    await expect(moveItemToLane(ITEM, WS, { kind: "squad", squadId: "foreign" })).rejects.toThrow("Related record not found");
    expect(roadmapItem.update).not.toHaveBeenCalled();
  });
});

describe("moveItemToLane custom-field lanes", () => {
  it("upserts the option value for the item and field", async () => {
    await moveItemToLane(ITEM, WS, { kind: "customField", fieldId: "field-a", value: "blue" });
    expect(customFieldDefinition.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "field-a", workspaceId: WS } }),
    );
    expect(customFieldValue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fieldId_objectId: { fieldId: "field-a", objectId: ITEM } },
        create: { fieldId: "field-a", objectId: ITEM, value: "blue" },
      }),
    );
    expect(roadmapItem.update).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("deletes the stored value for the Unassigned lane", async () => {
    await moveItemToLane(ITEM, WS, { kind: "customField", fieldId: "field-a", value: null });
    expect(customFieldValue.deleteMany).toHaveBeenCalledWith({ where: { fieldId: "field-a", objectId: ITEM } });
    expect(customFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("rejects a field from another workspace", async () => {
    customFieldDefinition.findFirst.mockResolvedValueOnce(null);
    await expect(
      moveItemToLane(ITEM, WS, { kind: "customField", fieldId: "foreign", value: "red" }),
    ).rejects.toThrow("Related record not found");
    expect(customFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("rejects a field defined for another object type", async () => {
    customFieldDefinition.findFirst.mockResolvedValueOnce({ ...selectField, objectType: "TASK" });
    await expect(
      moveItemToLane(ITEM, WS, { kind: "customField", fieldId: "field-a", value: "red" }),
    ).rejects.toThrow("Related record not found");
    expect(customFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("rejects non-SELECT fields", async () => {
    customFieldDefinition.findFirst.mockResolvedValueOnce({ ...selectField, fieldType: "MULTI_SELECT" });
    await expect(
      moveItemToLane(ITEM, WS, { kind: "customField", fieldId: "field-a", value: "red" }),
    ).rejects.toThrow(/single-select/);
    expect(customFieldValue.upsert).not.toHaveBeenCalled();
  });

  it("rejects a value that is not a current option", async () => {
    await expect(
      moveItemToLane(ITEM, WS, { kind: "customField", fieldId: "field-a", value: "green" }),
    ).rejects.toThrow(/not an option/);
    expect(customFieldValue.upsert).not.toHaveBeenCalled();
  });
});
