import { describe, expect, it } from "vitest";
import { groupableOpportunityFields, resolveDiscoveryGroupBy, fieldColumns } from "@/lib/opportunity-field-board";
import type { CustomFieldDefinitionData } from "@/lib/types";

const field: CustomFieldDefinitionData = { id: "moscow", name: "MoSCoW", fieldType: "SELECT", objectType: "OPPORTUNITY", options: [{ label: "Should", value: "should", color: "#123456" }], sharedOptionSetId: null, sharedOptionSetName: null, required: false, order: 0 };
describe("Opportunity field grouping", () => {
  it("offers only nonempty Opportunity single-select definitions", () => {
    expect(groupableOpportunityFields([field, { ...field, id: "multi", fieldType: "MULTI_SELECT" }, { ...field, id: "solution", objectType: "SOLUTION" }, { ...field, id: "empty", options: [] }])).toEqual([field]);
  });
  it("resolves built-in and eligible field URLs and falls back for stale URLs", () => {
    expect(resolveDiscoveryGroupBy("field:moscow", [field])).toBe("field:moscow");
    expect(resolveDiscoveryGroupBy("opportunity", [field])).toBe("opportunity");
    for (const value of [undefined, "field:", "field:deleted", "moscow"]) expect(resolveDiscoveryGroupBy(value, [field])).toBe("status");
  });
  it("puts absent and stale values in Unspecified without colliding with real option values", () => {
    const columns = fieldColumns(field.options!);
    expect(columns).toEqual([{ id: "unspecified", label: "Unspecified", value: null }, { id: "option:should", label: "Should", value: "should", color: "#123456" }]);
  });
});

import { columnValueFor, validateOpportunityFieldMove, groupByFieldId, fieldGroupByValue } from "@/lib/opportunity-field-board";

describe("Opportunity field column values", () => {
  const options = [{ label: "Must", value: "must" }, { label: "Should", value: "should" }];
  it("maps stored values to their option, and absent, stale or non-string values to Unspecified", () => {
    expect(columnValueFor("must", options)).toBe("must");
    for (const stored of [undefined, null, "", "removed-option", ["must"], 3]) expect(columnValueFor(stored, options)).toBeNull();
  });
  it("round-trips the field grouping value", () => {
    expect(groupByFieldId(fieldGroupByValue("moscow"))).toBe("moscow");
    expect(groupByFieldId("status")).toBeNull();
    expect(groupByFieldId("opportunity")).toBeNull();
  });
  it("only allows effective options or a clear on Opportunity single-select fields", () => {
    const eligible = { objectType: "OPPORTUNITY" as const, fieldType: "SELECT" as const, options };
    expect(validateOpportunityFieldMove(eligible, "should")).toBeNull();
    expect(validateOpportunityFieldMove(eligible, null)).toBeNull();
    expect(validateOpportunityFieldMove(eligible, "wont")).toMatch(/no longer exists/);
    expect(validateOpportunityFieldMove({ ...eligible, fieldType: "MULTI_SELECT" }, "must")).toMatch(/single-select/);
    expect(validateOpportunityFieldMove({ ...eligible, objectType: "SOLUTION" }, null)).toMatch(/Opportunity field/);
  });
});
