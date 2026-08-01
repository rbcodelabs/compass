"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { MemberData, TaskPriority } from "@/lib/types";

interface AssigneeProps {
  members: MemberData[];
}

/** Filter pill bar by assignee, mirroring SquadFilterBar's pattern exactly. */
export function AssigneeFilterBar({ members }: AssigneeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeAssignee = searchParams.get("assignee");

  if (members.length === 0) return null;

  function setFilter(userId: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (userId) {
      params.set("assignee", userId);
    } else {
      params.delete("assignee");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-slate-400 font-medium mr-1">Assignee:</span>
      <button
        onClick={() => setFilter(null)}
        className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
          !activeAssignee ? "bg-slate-800 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800"
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
              : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800"
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activePriority = searchParams.get("priority");

  function setFilter(priority: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (priority) {
      params.set("priority", priority);
    } else {
      params.delete("priority");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-slate-400 font-medium mr-1">Priority:</span>
      <button
        onClick={() => setFilter(null)}
        className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
          !activePriority ? "bg-slate-800 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800"
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
              : "bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800"
          }`}
        >
          {priority}
        </button>
      ))}
    </div>
  );
}
