"use client";

import { FacetedFilterMenu, type FacetedFilterGroup } from "@/components/patterns/faceted-filter-menu";
import { useUrlState } from "@/hooks/use-url-state";
import { CUSTOM_FIELD_FILTER_PARAMS, customFieldFacetedGroups } from "@/lib/custom-field-filter-menu";
import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter";
import type { SquadData } from "@/lib/types";

/** Roadmap's Filter slot: squad plus picklist custom-field tags, in the shared faceted menu. */
export function RoadmapFilters({
  squads,
  customFieldGroups = [],
  activeCustomFieldId = null,
}: {
  squads: SquadData[];
  /** Picklist fields on Roadmap Item that have options to filter by. */
  customFieldGroups?: CustomFieldFilterGroup[];
  /** The field the active filter resolved to on this page, if any. */
  activeCustomFieldId?: string | null;
}) {
  const { params, set } = useUrlState();

  const groups: FacetedFilterGroup[] = [
    ...(squads.length > 0
      ? [
          {
            id: "squad",
            label: "Squad",
            value: params.get("squad"),
            onValueChange: (value: string | null) => set({ squad: value }),
            options: squads.map((squad) => ({ value: squad.id, label: squad.name, color: squad.color })),
          } satisfies FacetedFilterGroup,
        ]
      : []),
    ...customFieldFacetedGroups({
      groups: customFieldGroups,
      activeFieldId: activeCustomFieldId,
      activeValue: params.get("fieldValue"),
      // One tag filter at a time: a value in a second field replaces the first,
      // and clearing removes both halves of the pair together.
      onChange: (fieldId, value) => set({ field: value ? fieldId : null, fieldValue: value }),
    }),
  ];

  if (groups.length === 0) return null;

  return (
    <FacetedFilterMenu
      iconOnly
      groups={groups}
      onClearAll={() => set({ squad: null, ...Object.fromEntries(CUSTOM_FIELD_FILTER_PARAMS.map((name) => [name, null])) })}
    />
  );
}
