"use client";

import { useUrlState } from "@/hooks/use-url-state";
import type { MemberData, TaskPriority } from "@/lib/types";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/task-meta";
import { assigneeValue, useTaskAssignees } from "./task-assignee-picker";

interface AssigneeProps {
  members: MemberData[];
}

/** Filter pill bar by assignee, mirroring SquadFilterBar's pattern exactly. */
export function AssigneeFilterBar({ members }: AssigneeProps) {
  const { params, set } = useUrlState();
  const activeAssignee = params.get("assignee");
  const selected = activeAssignee && !activeAssignee.includes(":") ? `user:${activeAssignee}` : activeAssignee;
  const { options } = useTaskAssignees(members);

  if (options.length === 0) return null;

  function setFilter(userId: string | null) {
    set({ assignee: userId });
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-text-subtle font-medium mr-1">Assignee:</span>
      <button
        onClick={() => setFilter(null)}
        className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
          !activeAssignee ? "bg-slate-800 text-white shadow-sm" : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
        }`}
      >
        All
      </button>
      {options.map((member) => (
        <button
          key={assigneeValue(member)}
          onClick={() => setFilter(assigneeValue(member) === selected ? null : assigneeValue(member))}
          className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
            selected === assigneeValue(member)
              ? "bg-slate-800 text-white shadow-sm"
              : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
          }`}
        >
          {member.type === "AGENT" ? "Agent: " : ""}{member.displayName}
        </button>
      ))}
    </div>
  );
}

const PRIORITIES: TaskPriority[] = [...TASK_PRIORITIES];

/** Filter pill bar by priority, same identical pattern as SquadFilterBar/AssigneeFilterBar. */
export function PriorityFilterBar() {
  const { params, set } = useUrlState();
  const activePriority = params.get("priority");

  function setFilter(priority: string | null) {
    set({ priority });
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-text-subtle font-medium mr-1">Priority:</span>
      <button
        onClick={() => setFilter(null)}
        className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
          !activePriority ? "bg-slate-800 text-white shadow-sm" : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
        }`}
      >
        All
      </button>
      {PRIORITIES.map((priority) => (
        <button
          key={priority}
          onClick={() => setFilter(priority === activePriority ? null : priority)}
          className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
            activePriority === priority
              ? "bg-slate-800 text-white shadow-sm"
              : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
          }`}
        >
          {TASK_PRIORITY_LABELS[priority]}
        </button>
      ))}
    </div>
  );
}
