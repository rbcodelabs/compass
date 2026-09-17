"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FacetedFilterMenu, type FacetedFilterGroup } from "@/components/patterns/faceted-filter-menu";
import {
  CUSTOM_FIELD_FILTER_PARAMS,
  applyCustomFieldFilterParams,
  customFieldFacetedGroups,
} from "@/lib/custom-field-filter-menu";
import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter";
import type { SquadData } from "@/lib/types";

export function DiscoveryFilters({
  squads,
  customFieldGroups = [],
  activeCustomFieldId = null,
}: {
  squads: SquadData[];
  /** Picklist fields on Opportunity and Solution that have options to filter by. */
  customFieldGroups?: CustomFieldFilterGroup[];
  /** The field the active filter actually resolved to on this page. */
  activeCustomFieldId?: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  function push(params: URLSearchParams) {
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function setSquad(value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("squad", value);
    } else {
      params.delete("squad");
    }
    push(params);
  }

  function setCustomField(fieldId: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    applyCustomFieldFilterParams(params, fieldId, value);
    push(params);
  }

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("squad");
    for (const name of CUSTOM_FIELD_FILTER_PARAMS) params.delete(name);
    push(params);
  }

  const groups: FacetedFilterGroup[] = [
    ...(squads.length > 0
      ? [
          {
            id: "squad",
            label: "Squad",
            value: searchParams.get("squad"),
            onValueChange: setSquad,
            options: squads.map((squad) => ({
              value: squad.id,
              label: squad.name,
              color: squad.color,
            })),
          } satisfies FacetedFilterGroup,
        ]
      : []),
    ...customFieldFacetedGroups({
      groups: customFieldGroups,
      activeFieldId: activeCustomFieldId,
      activeValue: searchParams.get("fieldValue"),
      onChange: setCustomField,
    }),
  ];

  if (groups.length === 0) return null;

  return <FacetedFilterMenu onClearAll={clearAll} groups={groups} />;
}
