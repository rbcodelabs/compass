"use client";

import { useUrlState } from "@/hooks/use-url-state";
import type { MemberData, TaskPriority } from "@/lib/types";

interface AssigneeProps {
  members: MemberData[];
}

/** Filter pill bar by assignee, mirroring SquadFilterBar's pattern exactly. */
export function AssigneeFilterBar({ members }: AssigneeProps) {
  const { params, set } = useUrlState();
  const activeAssignee = params.get("assignee");

  if (members.length === 0) return null;

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
      {members.map((member) => (
        <button
          key={member.userId}
          onClick={() => setFilter(member.userId === activeAssignee ? null : member.userId)}
          className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
            activeAssignee === member.userId
              ? "bg-slate-800 text-white shadow-sm"
              : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
          }`}
        >
          {member.name || member.email}
        </button>
      ))}
    </div>
  );
}

const PRIORITIES: TaskPriority[] = ["URGENT", "HIGH", "MEDIUM", "LOW"];

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
          {priority}
        </button>
      ))}
    </div>
  );
}
