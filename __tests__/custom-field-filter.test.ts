import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseCustomFieldFilterParams,
  buildCustomFieldFilterGroups,
  resolveCustomFieldFilter,
  type CustomFieldFilterDelegate,
} from "@/lib/custom-field-filter";
import type { CustomFieldDefinitionData } from "@/lib/types";

describe("parseCustomFieldFilterParams", () => {
  it("returns null when either half of the pair is missing", () => {
    expect(parseCustomFieldFilterParams({})).toBeNull();
    expect(parseCustomFieldFilterParams({ field: "f1" })).toBeNull();
    expect(parseCustomFieldFilterParams({ fieldValue: "payments" })).toBeNull();
  });

  it("returns null when either half is blank after trimming", () => {
    expect(parseCustomFieldFilterParams({ field: "  ", fieldValue: "payments" })).toBeNull();
    expect(parseCustomFieldFilterParams({ field: "f1", fieldValue: "  " })).toBeNull();
  });

  it("returns the trimmed pair when both are present", () => {
    expect(parseCustomFieldFilterParams({ field: " f1 ", fieldValue: " payments " })).toEqual({
      fieldId: "f1",
      value: "payments",
    });
  });
});

describe("buildCustomFieldFilterGroups", () => {
  const fields: CustomFieldDefinitionData[] = [
    {
      id: "f-text",
      name: "Notes",
      fieldType: "TEXT",
      objectType: "OPPORTUNITY",
      options: null,
      sharedOptionSetId: null,
      sharedOptionSetName: null,
      required: false,
      order: 0,
    },
    {
      id: "f-empty",
      name: "Empty picklist",
      fieldType: "SELECT",
      objectType: "OPPORTUNITY",
      options: [],
      sharedOptionSetId: null,
      sharedOptionSetName: null,
      required: false,
      order: 1,
    },
    {
      id: "f-area",
      name: "Product Area",
      fieldType: "MULTI_SELECT",
      objectType: "OPPORTUNITY",
      options: [
        { label: "Payments", value: "payments", color: "#abc" },
        { label: "Billing", value: "billing" },
      ],
      sharedOptionSetId: "set-1",
      sharedOptionSetName: "Product Area",
      required: false,
      order: 2,
    },
  ];

  it("only includes SELECT / MULTI_SELECT fields that actually have options", () => {
    const groups = buildCustomFieldFilterGroups(fields);
    expect(groups.map((group) => group.fieldId)).toEqual(["f-area"]);
  });

  it("carries the field name, object type and option list onto the group", () => {
    const [group] = buildCustomFieldFilterGroups(fields);
    expect(group.label).toBe("Product Area");
    expect(group.objectType).toBe("OPPORTUNITY");
    expect(group.options).toEqual([
      { value: "payments", label: "Payments", color: "#abc" },
      { value: "billing", label: "Billing", color: null },
    ]);
  });

  it("disambiguates two fields that share a name across object types", () => {
    const groups = buildCustomFieldFilterGroups([
      { ...fields[2], id: "a", objectType: "OPPORTUNITY" },
      { ...fields[2], id: "b", objectType: "SOLUTION" },
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Product Area (Opportunity)",
      "Product Area (Solution)",
    ]);
  });
});

describe("resolveCustomFieldFilter", () => {
  const definition = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };
  const value = { findMany: vi.fn() };
  const delegate = {
    customFieldDefinition: definition,
    customFieldValue: value,
  } as unknown as CustomFieldFilterDelegate;

  beforeEach(() => {
    definition.findFirst.mockReset();
    definition.findMany.mockReset();
    value.findMany.mockReset();
  });

  it("returns null when there is no filter", async () => {
    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["OPPORTUNITY"],
        filter: null,
      })
    ).resolves.toBeNull();
    expect(definition.findFirst).not.toHaveBeenCalled();
  });

  it("returns null when the field definition is not in this workspace", async () => {
    definition.findFirst.mockResolvedValue(null);
    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["OPPORTUNITY"],
        filter: { fieldId: "f1", value: "payments" },
      })
    ).resolves.toBeNull();
    expect(definition.findFirst).toHaveBeenCalledWith({
      where: { id: "f1", workspaceId: "w1" },
      select: { id: true, objectType: true, sharedOptionSetId: true },
    });
  });

  it("matches MULTI_SELECT arrays by containment and returns the matching object ids", async () => {
    definition.findFirst.mockResolvedValue({
      id: "f1",
      objectType: "OPPORTUNITY",
      sharedOptionSetId: null,
    });
    value.findMany.mockResolvedValue([
      { objectId: "o1", value: ["payments", "billing"] },
      { objectId: "o2", value: ["billing"] },
      { objectId: "o3", value: "payments" },
      { objectId: "o4", value: null },
    ]);

    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["OPPORTUNITY"],
        filter: { fieldId: "f1", value: "payments" },
      })
    ).resolves.toEqual({ fieldId: "f1", objectType: "OPPORTUNITY", objectIds: ["o1", "o3"] });

    expect(value.findMany).toHaveBeenCalledWith({
      where: { fieldId: "f1" },
      select: { objectId: true, value: true },
    });
  });

  it("returns an empty id list — not null — when the filter matches nothing", async () => {
    definition.findFirst.mockResolvedValue({
      id: "f1",
      objectType: "TASK",
      sharedOptionSetId: null,
    });
    value.findMany.mockResolvedValue([{ objectId: "t1", value: ["billing"] }]);

    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["TASK"],
        filter: { fieldId: "f1", value: "payments" },
      })
    ).resolves.toEqual({ fieldId: "f1", objectType: "TASK", objectIds: [] });
  });

  it("re-points a carried-over filter at this page's field on the same shared set", async () => {
    // The user filtered Discovery by the OPPORTUNITY "Product Area" field, then
    // navigated to Tasks with the params intact. Both fields share one set, so
    // the tag survives the navigation instead of silently doing nothing.
    definition.findFirst.mockResolvedValue({
      id: "opp-field",
      objectType: "OPPORTUNITY",
      sharedOptionSetId: "set-1",
    });
    definition.findMany.mockResolvedValue([{ id: "task-field", objectType: "TASK" }]);
    value.findMany.mockResolvedValue([{ objectId: "t1", value: ["payments"] }]);

    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["TASK"],
        filter: { fieldId: "opp-field", value: "payments" },
      })
    ).resolves.toEqual({ fieldId: "task-field", objectType: "TASK", objectIds: ["t1"] });

    expect(definition.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "w1", sharedOptionSetId: "set-1", objectType: { in: ["TASK"] } },
      select: { id: true, objectType: true },
      orderBy: { order: "asc" },
    });
    expect(value.findMany).toHaveBeenCalledWith({
      where: { fieldId: "task-field" },
      select: { objectId: true, value: true },
    });
  });

  it("ignores a carried-over filter with no counterpart on this page", async () => {
    definition.findFirst.mockResolvedValue({
      id: "opp-field",
      objectType: "OPPORTUNITY",
      sharedOptionSetId: "set-1",
    });
    definition.findMany.mockResolvedValue([]);

    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["TASK"],
        filter: { fieldId: "opp-field", value: "payments" },
      })
    ).resolves.toBeNull();
    expect(value.findMany).not.toHaveBeenCalled();
  });

  it("ignores a carried-over filter on a field with no shared set", async () => {
    definition.findFirst.mockResolvedValue({
      id: "opp-field",
      objectType: "OPPORTUNITY",
      sharedOptionSetId: null,
    });

    await expect(
      resolveCustomFieldFilter(delegate, {
        workspaceId: "w1",
        objectTypes: ["TASK"],
        filter: { fieldId: "opp-field", value: "payments" },
      })
    ).resolves.toBeNull();
    expect(definition.findMany).not.toHaveBeenCalled();
    expect(value.findMany).not.toHaveBeenCalled();
  });
});
