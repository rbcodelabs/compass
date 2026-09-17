import { describe, it, expect, vi } from "vitest";
import {
  toCustomFieldDefinitionData,
  loadCustomFieldDefinitions,
} from "@/lib/custom-field-definitions";

describe("toCustomFieldDefinitionData", () => {
  it("surfaces the shared set's options as the field's effective options", () => {
    expect(
      toCustomFieldDefinitionData({
        id: "f1",
        name: "Product Area",
        fieldType: "MULTI_SELECT",
        objectType: "TASK",
        options: [{ label: "Stale", value: "stale" }],
        sharedOptionSetId: "set-1",
        required: false,
        order: 2,
        sharedOptionSet: {
          id: "set-1",
          name: "Product Area",
          options: [{ label: "Payments", value: "payments" }],
        },
      })
    ).toEqual({
      id: "f1",
      name: "Product Area",
      fieldType: "MULTI_SELECT",
      objectType: "TASK",
      options: [{ label: "Payments", value: "payments" }],
      sharedOptionSetId: "set-1",
      sharedOptionSetName: "Product Area",
      required: false,
      order: 2,
    });
  });

  it("uses the local options and reports no shared set when detached", () => {
    const data = toCustomFieldDefinitionData({
      id: "f2",
      name: "Priority",
      fieldType: "SELECT",
      objectType: "OPPORTUNITY",
      options: [{ label: "High", value: "high" }],
      sharedOptionSetId: null,
      required: true,
      order: 0,
      sharedOptionSet: null,
    });
    expect(data.options).toEqual([{ label: "High", value: "high" }]);
    expect(data.sharedOptionSetId).toBeNull();
    expect(data.sharedOptionSetName).toBeNull();
  });

  it("reports null options for a non-picklist field", () => {
    const data = toCustomFieldDefinitionData({
      id: "f3",
      name: "Notes",
      fieldType: "TEXT",
      objectType: "TASK",
      options: null,
      sharedOptionSetId: null,
      required: false,
      order: 0,
      sharedOptionSet: null,
    });
    expect(data.options).toBeNull();
  });
});

describe("loadCustomFieldDefinitions", () => {
  it("queries by workspace and object types, ordered, with the shared set joined", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await loadCustomFieldDefinitions(
      { customFieldDefinition: { findMany } } as never,
      { workspaceId: "w1", objectTypes: ["OPPORTUNITY", "SOLUTION"] }
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: "w1", objectType: { in: ["OPPORTUNITY", "SOLUTION"] } },
      orderBy: [{ objectType: "asc" }, { order: "asc" }],
      include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
    });
  });

  it("omits the objectType predicate when no object types are given", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await loadCustomFieldDefinitions(
      { customFieldDefinition: { findMany } } as never,
      { workspaceId: "w1" }
    );
    expect(findMany.mock.calls[0][0].where).toEqual({ workspaceId: "w1" });
  });
});
