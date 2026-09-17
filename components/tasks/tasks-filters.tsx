"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FacetedFilterMenu } from "@/components/patterns/faceted-filter-menu";
import type { MemberData, SquadData, TaskPriority } from "@/lib/types";
import {
  UNASSIGNED_ASSIGNEE_FILTER,
  UNASSIGNED_ASSIGNEE_LABEL,
  canonicalAssigneeFilterValue,
} from "@/lib/task-assignee-display";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/task-meta";
import {
  CUSTOM_FIELD_FILTER_PARAMS,
  applyCustomFieldFilterParams,
  customFieldFacetedGroups,
} from "@/lib/custom-field-filter-menu";
import type { CustomFieldFilterGroup } from "@/lib/custom-field-filter";
import { assigneeValue, useTaskAssignees } from "./task-assignee-picker";

const PRIORITIES: TaskPriority[] = [...TASK_PRIORITIES];

type TasksFiltersProps = {
  squads: SquadData[];
  members: MemberData[];
  customFieldGroups?: CustomFieldFilterGroup[];
  activeCustomFieldId?: string | null;
};

export function TasksFilters({
  squads,
  members,
  customFieldGroups = [],
  activeCustomFieldId = null,
}: TasksFiltersProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { options } = useTaskAssignees(members);
  const selected = searchParams.get("assignee");

  function push(params: URLSearchParams) {
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function setFilter(key: "squad" | "assignee" | "priority", value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
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
    params.delete("assignee");
    params.delete("priority");
    for (const name of CUSTOM_FIELD_FILTER_PARAMS) params.delete(name);
    push(params);
  }

  return (
    <FacetedFilterMenu
      onClearAll={clearAll}
      groups={[
        {
          id: "squad",
          label: "Squad",
          value: searchParams.get("squad"),
          onValueChange: (value) => setFilter("squad", value),
          options: squads.map((squad) => ({
            value: squad.id,
            label: squad.name,
            color: squad.color,
          })),
        },
        {
          id: "assignee",
          label: "Assignee",
          value: canonicalAssigneeFilterValue(selected),
          onValueChange: (value) => setFilter("assignee", value),
          options: [
            { value: UNASSIGNED_ASSIGNEE_FILTER, label: UNASSIGNED_ASSIGNEE_LABEL },
            ...options.map((option) => ({
              value: assigneeValue(option),
              label: `${option.type === "AGENT" ? "Agent: " : ""}${option.displayName}`,
            })),
          ],
        },
        {
          id: "priority",
          label: "Priority",
          value: searchParams.get("priority"),
          onValueChange: (value) => setFilter("priority", value),
          options: PRIORITIES.map((priority) => ({
            value: priority,
            label: TASK_PRIORITY_LABELS[priority],
          })),
        },
        ...customFieldFacetedGroups({
          groups: customFieldGroups,
          activeFieldId: activeCustomFieldId,
          activeValue: searchParams.get("fieldValue"),
          onChange: setCustomField,
        }),
      ]}
    />
  );
}
