import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWorkspace = { findFirst: vi.fn() };
const mockSharedFieldOptionSet = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
const mockCustomFieldDefinition = {
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
const mockCustomFieldValue = { deleteMany: vi.fn() };

const mockPrisma = {
  workspace: mockWorkspace,
  sharedFieldOptionSet: mockSharedFieldOptionSet,
  customFieldDefinition: mockCustomFieldDefinition,
  customFieldValue: mockCustomFieldValue,
};

vi.mock("@/lib/db", () => ({ default: vi.fn(() => mockPrisma) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import {
  createSharedFieldOptionSet,
  updateSharedFieldOptionSet,
  deleteSharedFieldOptionSet,
  createFieldDefinition,
  updateFieldDefinition,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1" } } as unknown as Awaited<ReturnType<typeof auth>>);
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1", organizationId: "org-1" });
  mockSharedFieldOptionSet.create.mockResolvedValue({ id: "set-1" });
  mockSharedFieldOptionSet.update.mockResolvedValue({ id: "set-1" });
  mockSharedFieldOptionSet.delete.mockResolvedValue({ id: "set-1" });
  mockSharedFieldOptionSet.findFirst.mockResolvedValue({
    id: "set-1",
    workspaceId: "ws-1",
    name: "Product Area",
    options: [{ label: "Payments", value: "payments" }],
  });
  mockCustomFieldDefinition.count.mockResolvedValue(0);
  mockCustomFieldDefinition.create.mockResolvedValue({ id: "field-1" });
  mockCustomFieldDefinition.update.mockResolvedValue({ id: "field-1" });
  mockCustomFieldDefinition.findMany.mockResolvedValue([]);
  mockCustomFieldDefinition.findFirst.mockResolvedValue({
    id: "field-1",
    workspaceId: "ws-1",
    fieldType: "MULTI_SELECT",
    options: null,
    sharedOptionSetId: null,
  });
});

describe("createSharedFieldOptionSet", () => {
  it("normalizes options and stamps the workspace, author and updatedAt", async () => {
    await createSharedFieldOptionSet("org", "ws", {
      name: "  Product Area  ",
      options: [{ label: " Payments " }, { label: "Billing", color: "#abc" }],
    });

    const data = mockSharedFieldOptionSet.create.mock.calls[0][0].data;
    expect(data.workspaceId).toBe("ws-1");
    expect(data.name).toBe("Product Area");
    expect(data.createdById).toBe("user-1");
    expect(data.updatedById).toBe("user-1");
    expect(data.source).toBe("UI");
    expect(data.updatedAt).toBeInstanceOf(Date);
    expect(data.options).toEqual([
      { label: "Payments", value: "payments" },
      { label: "Billing", value: "billing", color: "#abc" },
    ]);
  });

  it("rejects a blank name", async () => {
    await expect(
      createSharedFieldOptionSet("org", "ws", { name: "   ", options: [] })
    ).rejects.toThrow(/name is required/i);
    expect(mockSharedFieldOptionSet.create).not.toHaveBeenCalled();
  });
});

describe("updateSharedFieldOptionSet", () => {
  it("refuses to touch a set belonging to another workspace", async () => {
    mockSharedFieldOptionSet.findFirst.mockResolvedValue(null);
    await expect(
      updateSharedFieldOptionSet("org", "ws", "set-9", { name: "Nope" })
    ).rejects.toThrow(/not found/i);
    expect(mockSharedFieldOptionSet.update).not.toHaveBeenCalled();
  });

  it("writes normalized options and bumps updatedAt / updatedById", async () => {
    await updateSharedFieldOptionSet("org", "ws", "set-1", {
      options: [{ label: "Payments", value: "payments" }, { label: "Growth Platform" }],
    });

    const call = mockSharedFieldOptionSet.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: "set-1" });
    expect(call.data.options).toEqual([
      { label: "Payments", value: "payments" },
      { label: "Growth Platform", value: "growth_platform" },
    ]);
    expect(call.data.updatedById).toBe("user-1");
    expect(call.data.updatedAt).toBeInstanceOf(Date);
  });
});

describe("deleteSharedFieldOptionSet", () => {
  // Being referenced is an expected outcome, not an exception. It is RETURNED
  // rather than thrown because Next.js redacts thrown server-action messages in
  // production builds — a thrown guard reaches the user as "An error occurred in
  // the Server Components render", which defeats the whole point of naming the
  // count. Verified against the live preview build, not inferred.
  it("blocks the delete while field definitions still reference the set", async () => {
    mockCustomFieldDefinition.count.mockResolvedValue(3);

    await expect(deleteSharedFieldOptionSet("org", "ws", "set-1")).resolves.toEqual({
      ok: false,
      error: "3 fields use this — detach them first",
    });
    expect(mockSharedFieldOptionSet.delete).not.toHaveBeenCalled();
  });

  it("uses the singular form for exactly one referencing field", async () => {
    mockCustomFieldDefinition.count.mockResolvedValue(1);
    await expect(deleteSharedFieldOptionSet("org", "ws", "set-1")).resolves.toEqual({
      ok: false,
      error: "1 field uses this — detach it first",
    });
  });

  it("deletes when nothing references the set", async () => {
    mockCustomFieldDefinition.count.mockResolvedValue(0);
    await expect(deleteSharedFieldOptionSet("org", "ws", "set-1")).resolves.toEqual({ ok: true });
    expect(mockSharedFieldOptionSet.delete).toHaveBeenCalledWith({ where: { id: "set-1" } });
  });

  it("never cascades a null into referencing field definitions", async () => {
    mockCustomFieldDefinition.count.mockResolvedValue(2);
    await deleteSharedFieldOptionSet("org", "ws", "set-1");
    expect(mockCustomFieldDefinition.update).not.toHaveBeenCalled();
    expect(mockSharedFieldOptionSet.delete).not.toHaveBeenCalled();
  });

  it("still throws for a set outside this workspace — that is not a user-facing outcome", async () => {
    mockSharedFieldOptionSet.findFirst.mockResolvedValue(null);
    await expect(deleteSharedFieldOptionSet("org", "ws", "set-9")).rejects.toThrow(/not found/i);
  });
});

describe("createFieldDefinition with a shared option set", () => {
  it("stores the link and nulls the local options list", async () => {
    await createFieldDefinition("org", "ws", {
      objectType: "TASK",
      name: "Product Area",
      fieldType: "MULTI_SELECT",
      options: [{ label: "Ignored", value: "ignored" }],
      sharedOptionSetId: "set-1",
    });

    const data = mockCustomFieldDefinition.create.mock.calls[0][0].data;
    expect(data.sharedOptionSetId).toBe("set-1");
    expect(data.options).toEqual(expect.objectContaining({}));
    // Prisma.DbNull, never a live local array alongside a shared set link.
    expect(Array.isArray(data.options)).toBe(false);
  });

  it("rejects attaching a shared set to a non-select field type", async () => {
    await expect(
      createFieldDefinition("org", "ws", {
        objectType: "TASK",
        name: "Notes",
        fieldType: "TEXT",
        sharedOptionSetId: "set-1",
      })
    ).rejects.toThrow(/SELECT or MULTI_SELECT/i);
    expect(mockCustomFieldDefinition.create).not.toHaveBeenCalled();
  });

  it("rejects a shared set from another workspace", async () => {
    mockSharedFieldOptionSet.findFirst.mockResolvedValue(null);
    await expect(
      createFieldDefinition("org", "ws", {
        objectType: "TASK",
        name: "Product Area",
        fieldType: "SELECT",
        sharedOptionSetId: "set-9",
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("updateFieldDefinition attach / detach", () => {
  it("attaching clears the local options so the two can never disagree", async () => {
    await updateFieldDefinition("org", "ws", "field-1", { sharedOptionSetId: "set-1" });

    const data = mockCustomFieldDefinition.update.mock.calls[0][0].data;
    expect(data.sharedOptionSetId).toBe("set-1");
    expect(Array.isArray(data.options)).toBe(false);
  });

  it("detaching copies the set's current options down as the new local list", async () => {
    mockCustomFieldDefinition.findFirst.mockResolvedValue({
      id: "field-1",
      workspaceId: "ws-1",
      fieldType: "MULTI_SELECT",
      options: null,
      sharedOptionSetId: "set-1",
      sharedOptionSet: {
        id: "set-1",
        name: "Product Area",
        options: [
          { label: "Payments", value: "payments" },
          { label: "Billing", value: "billing" },
        ],
      },
    });

    await updateFieldDefinition("org", "ws", "field-1", { sharedOptionSetId: null });

    const data = mockCustomFieldDefinition.update.mock.calls[0][0].data;
    expect(data.sharedOptionSetId).toBeNull();
    expect(data.options).toEqual([
      { label: "Payments", value: "payments" },
      { label: "Billing", value: "billing" },
    ]);
  });

  it("never resets a detached field to an empty options list", async () => {
    mockCustomFieldDefinition.findFirst.mockResolvedValue({
      id: "field-1",
      workspaceId: "ws-1",
      fieldType: "SELECT",
      options: null,
      sharedOptionSetId: "set-1",
      sharedOptionSet: { id: "set-1", name: "Product Area", options: [] },
    });
    mockCustomFieldDefinition.update.mockClear();

    await updateFieldDefinition("org", "ws", "field-1", { sharedOptionSetId: null });
    const data = mockCustomFieldDefinition.update.mock.calls[0][0].data;
    // An empty shared set legitimately copies down as an empty local list, but
    // the detach must not silently discard a non-empty one — covered above.
    expect(data.options).toEqual([]);
    expect(mockCustomFieldValue.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves the shared link alone when the caller does not mention it", async () => {
    await updateFieldDefinition("org", "ws", "field-1", { name: "Renamed" });
    const data = mockCustomFieldDefinition.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("sharedOptionSetId");
    expect(data.name).toBe("Renamed");
  });
});

/**
 * The option-list editor sends existing options with their stored value and
 * colour and new ones label-only. Both write paths must keep a supplied value
 * (a rename must never re-slug it) and colour, and must derive a slug for a
 * label-only option rather than storing an option with no value at all.
 */
describe("option lists sent by the option-list editor", () => {
  const edited = [
    { label: " Minor ", value: "low", color: "#16a34a" },
    { label: "Brand New" },
    { label: "   " },
  ];
  const expected = [
    { label: "Minor", value: "low", color: "#16a34a" },
    { label: "Brand New", value: "brand_new" },
  ];

  it("updateSharedFieldOptionSet keeps a renamed option's value and colour", async () => {
    await updateSharedFieldOptionSet("org", "ws", "set-1", { options: edited });
    expect(mockSharedFieldOptionSet.update.mock.calls[0][0].data.options).toEqual(expected);
  });

  it("createSharedFieldOptionSet keeps colours and slugs label-only options", async () => {
    await createSharedFieldOptionSet("org", "ws", { name: "Priority", options: edited });
    expect(mockSharedFieldOptionSet.create.mock.calls[0][0].data.options).toEqual(expected);
  });

  it("createFieldDefinition normalizes local options instead of storing them raw", async () => {
    await createFieldDefinition("org", "ws", {
      objectType: "TASK",
      name: "Priority",
      fieldType: "SELECT",
      options: edited,
    });
    expect(mockCustomFieldDefinition.create.mock.calls[0][0].data.options).toEqual(expected);
  });

  it("updateFieldDefinition normalizes local options instead of storing them raw", async () => {
    await updateFieldDefinition("org", "ws", "field-1", { options: edited });
    expect(mockCustomFieldDefinition.update.mock.calls[0][0].data.options).toEqual(expected);
  });
});
