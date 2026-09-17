import { describe, it, expect, vi } from "vitest";
import { loadCustomFieldsForObject } from "@/lib/custom-field-definitions";

function fakePrisma(defs: unknown[], values: unknown[]) {
  const definitionFindMany = vi.fn().mockResolvedValue(defs);
  const valueFindMany = vi.fn().mockResolvedValue(values);
  return {
    prisma: {
      customFieldDefinition: { findMany: definitionFindMany },
      customFieldValue: { findMany: valueFindMany },
    } as never,
    definitionFindMany,
    valueFindMany,
  };
}

const productArea = {
  id: "field-area",
  name: "Product Area",
  fieldType: "MULTI_SELECT",
  objectType: "ROADMAP_ITEM",
  options: null,
  sharedOptionSetId: "set-1",
  required: false,
  order: 0,
  sharedOptionSet: {
    id: "set-1",
    name: "Product Area",
    options: [
      { label: "ZZ Alpha", value: "zz_alpha" },
      { label: "ZZ Beta", value: "zz_beta" },
    ],
  },
};

describe("loadCustomFieldsForObject", () => {
  it("queries definitions for exactly one object type, ordered, with the shared set joined", async () => {
    const { prisma, definitionFindMany } = fakePrisma([], []);
    await loadCustomFieldsForObject(prisma, {
      workspaceId: "w1",
      objectType: "ROADMAP_ITEM",
      objectId: "ri-1",
    });
    expect(definitionFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "w1", objectType: "ROADMAP_ITEM" },
      orderBy: { order: "asc" },
      include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
    });
  });

  it("resolves a ROADMAP_ITEM's shared-set options and its stored value", async () => {
    const { prisma, valueFindMany } = fakePrisma(
      [productArea],
      [{ fieldId: "field-area", value: ["zz_alpha"] }]
    );

    const fields = await loadCustomFieldsForObject(prisma, {
      workspaceId: "w1",
      objectType: "ROADMAP_ITEM",
      objectId: "ri-1",
    });

    expect(valueFindMany).toHaveBeenCalledWith({
      where: { fieldId: { in: ["field-area"] }, objectId: "ri-1" },
    });
    expect(fields).toEqual([
      {
        id: "field-area",
        name: "Product Area",
        fieldType: "MULTI_SELECT",
        objectType: "ROADMAP_ITEM",
        options: [
          { label: "ZZ Alpha", value: "zz_alpha" },
          { label: "ZZ Beta", value: "zz_beta" },
        ],
        sharedOptionSetId: "set-1",
        sharedOptionSetName: "Product Area",
        required: false,
        order: 0,
        currentValue: ["zz_alpha"],
      },
    ]);
  });

  it("resolves a SOLUTION's fields the same way", async () => {
    const { prisma, definitionFindMany } = fakePrisma(
      [{ ...productArea, id: "field-sol-area", objectType: "SOLUTION" }],
      [{ fieldId: "field-sol-area", value: ["zz_beta"] }]
    );

    const fields = await loadCustomFieldsForObject(prisma, {
      workspaceId: "w1",
      objectType: "SOLUTION",
      objectId: "sol-1",
    });

    expect(definitionFindMany.mock.calls[0][0].where).toEqual({
      workspaceId: "w1",
      objectType: "SOLUTION",
    });
    expect(fields[0].objectType).toBe("SOLUTION");
    expect(fields[0].currentValue).toEqual(["zz_beta"]);
  });

  it("reports a null currentValue for a field the object has never been tagged with", async () => {
    const { prisma } = fakePrisma([productArea], []);
    const fields = await loadCustomFieldsForObject(prisma, {
      workspaceId: "w1",
      objectType: "ROADMAP_ITEM",
      objectId: "ri-untagged",
    });
    expect(fields).toHaveLength(1);
    expect(fields[0].currentValue).toBeNull();
  });

  it("does not query values at all when the workspace defines no fields for the type", async () => {
    const { prisma, valueFindMany } = fakePrisma([], []);
    const fields = await loadCustomFieldsForObject(prisma, {
      workspaceId: "w1",
      objectType: "SOLUTION",
      objectId: "sol-1",
    });
    expect(fields).toEqual([]);
    expect(valueFindMany).not.toHaveBeenCalled();
  });
});
