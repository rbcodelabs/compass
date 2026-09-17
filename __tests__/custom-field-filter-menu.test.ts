import { describe, it, expect, vi } from "vitest";
import {
  customFieldFacetedGroups,
  applyCustomFieldFilterParams,
  CUSTOM_FIELD_FILTER_PARAMS,
} from "@/lib/custom-field-filter-menu";
import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter";

const groups: CustomFieldFilterGroup[] = [
  {
    fieldId: "f-area",
    label: "Product Area",
    objectType: "OPPORTUNITY",
    options: [
      { value: "payments", label: "Payments", color: "#abc" },
      { value: "billing", label: "Billing", color: null },
    ],
  },
  {
    fieldId: "f-tier",
    label: "Tier",
    objectType: "OPPORTUNITY",
    options: [{ value: "t1", label: "Tier 1", color: null }],
  },
];

describe("customFieldFacetedGroups", () => {
  it("renders one single-select group per filterable field", () => {
    const built = customFieldFacetedGroups({ groups, activeFieldId: null, onChange: vi.fn() });
    expect(built.map((g) => g.id)).toEqual(["custom-field:f-area", "custom-field:f-tier"]);
    expect(built.map((g) => g.label)).toEqual(["Product Area", "Tier"]);
    expect(built[0].options).toEqual([
      { value: "payments", label: "Payments", color: "#abc" },
      { value: "billing", label: "Billing", color: null },
    ]);
  });

  it("marks only the active field's group as selected", () => {
    const built = customFieldFacetedGroups({
      groups,
      activeFieldId: "f-tier",
      activeValue: "t1",
      onChange: vi.fn(),
    });
    expect(built[0].value).toBeNull();
    expect(built[1].value).toBe("t1");
  });

  it("selecting a value reports the owning field id", () => {
    const onChange = vi.fn();
    const built = customFieldFacetedGroups({ groups, activeFieldId: null, onChange });
    built[0].onValueChange!("payments");
    expect(onChange).toHaveBeenCalledWith("f-area", "payments");
  });

  it("clearing a group reports a null value so only one filter is ever live", () => {
    const onChange = vi.fn();
    const built = customFieldFacetedGroups({ groups, activeFieldId: "f-area", activeValue: "payments", onChange });
    built[0].onValueChange!(null);
    expect(onChange).toHaveBeenCalledWith("f-area", null);
  });
});

describe("applyCustomFieldFilterParams", () => {
  it("sets both halves of the pair together", () => {
    const params = new URLSearchParams("squad=s1");
    applyCustomFieldFilterParams(params, "f-area", "payments");
    expect(params.get("field")).toBe("f-area");
    expect(params.get("fieldValue")).toBe("payments");
    expect(params.get("squad")).toBe("s1");
  });

  it("removes both halves when the value is cleared", () => {
    const params = new URLSearchParams("field=f-area&fieldValue=payments&squad=s1");
    applyCustomFieldFilterParams(params, "f-area", null);
    expect(params.has("field")).toBe(false);
    expect(params.has("fieldValue")).toBe(false);
    expect(params.get("squad")).toBe("s1");
  });

  it("replaces a previous field rather than accumulating filters", () => {
    const params = new URLSearchParams("field=f-area&fieldValue=payments");
    applyCustomFieldFilterParams(params, "f-tier", "t1");
    expect(params.get("field")).toBe("f-tier");
    expect(params.get("fieldValue")).toBe("t1");
  });

  it("exposes the param names so clear-all can drop them", () => {
    expect([...CUSTOM_FIELD_FILTER_PARAMS]).toEqual(["field", "fieldValue"]);
  });
});
