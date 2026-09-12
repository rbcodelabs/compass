import type { ResolvedTaskAssignee } from "@/lib/task-assignment";
import type { MemberData } from "@/lib/types";

/**
 * Reserved `?assignee=` value meaning "no assignee at all". `assigneeUserId`
 * and `assigneeAgentId` are `@db.Uuid`, so an underscore-bearing sentinel can
 * never collide with a real id — and must never reach the query as one.
 */
export const UNASSIGNED_ASSIGNEE_FILTER = "__unassigned__";

export const UNASSIGNED_ASSIGNEE_LABEL = "Unassigned";

/** Muted, clearly-secondary treatment for an absent assignee. */
export const UNASSIGNED_ASSIGNEE_CLASS = "italic text-text-subtle/70";

/**
 * Normalizes an `?assignee=` param to the `user:`/`agent:`-prefixed form the
 * filter menu matches against, leaving the unassigned sentinel intact.
 */
export function canonicalAssigneeFilterValue(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === UNASSIGNED_ASSIGNEE_FILTER) return value;
  return value.includes(":") ? value : `user:${value}`;
}

type AssigneeSource = {
  assigneeUserId: string | null;
  assigneeAgentId?: string | null;
  assignee?: ResolvedTaskAssignee | null;
  ownerName: string | null;
};

export type TaskAssigneeDisplay = {
  label: string;
  /** False only when the assignee slot is genuinely empty. */
  assigned: boolean;
};

/**
 * Single source of truth for the assignee label on cards, the list view and the
 * task detail header, so the three surfaces cannot drift apart.
 *
 * `assigned: false` is reserved for a genuinely empty slot — no person, no
 * agent, and no freeform `ownerName`. A task that names an assignee we cannot
 * resolve stays `assigned: true` under an "unavailable" label: calling that
 * "Unassigned" would claim nobody owns work that is in fact on the record as
 * owned.
 */
export function taskAssigneeDisplay(task: AssigneeSource, members: MemberData[]): TaskAssigneeDisplay {
  if (task.assignee) {
    const prefix = task.assignee.type === "AGENT" ? "Agent: " : "";
    const suffix = task.assignee.available ? "" : " (unavailable)";
    return { label: `${prefix}${task.assignee.displayName}${suffix}`, assigned: true };
  }

  const member = task.assigneeUserId ? members.find((m) => m.userId === task.assigneeUserId) : null;
  const label =
    member?.name ||
    member?.email ||
    (task.assigneeUserId || task.assigneeAgentId ? "Unavailable assignee" : task.ownerName);

  return label ? { label, assigned: true } : { label: UNASSIGNED_ASSIGNEE_LABEL, assigned: false };
}
