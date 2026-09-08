"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Combobox, ComboboxContent, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox";
import { getTaskAssigneeOptions } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import type { MemberData } from "@/lib/types";
import type { ResolvedTaskAssignee, TaskAssignee } from "@/lib/task-assignment";

export function assigneeValue(value: TaskAssignee) { return value ? `${value.type.toLowerCase()}:${value.id}` : "__none__"; }
export function assigneeFromValue(value: string | null): TaskAssignee {
  if (!value || value === "__none__") return null;
  return { type: value.startsWith("agent:") ? "AGENT" : "USER", id: value.replace(/^(agent|user):/, "") };
}

export function useTaskAssignees(members: MemberData[]): { options: ResolvedTaskAssignee[]; error: string | null } {
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  const [options, setOptions] = useState<ResolvedTaskAssignee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orgSlug = params?.orgSlug;
  const workspaceSlug = params?.workspaceSlug;
  useEffect(() => {
    let active = true;
    if (orgSlug && workspaceSlug) {
      getTaskAssigneeOptions(orgSlug, workspaceSlug).then(result => { if (active) { setOptions(result); setError(null); } }).catch(() => { if (active) setError("Could not load workspace assignees. Reopen to retry."); });
    }
    return () => { active = false; };
  }, [orgSlug, workspaceSlug]);
  return { options: options ?? members.map(member => ({ type: "USER" as const, id: member.userId, displayName: member.name || member.email, available: true })), error };
}

export function TaskAssigneePicker({ id, members, value, onChange, current, disabled }: { id?: string; members: MemberData[]; value: TaskAssignee; onChange: (value: TaskAssignee) => void; current?: ResolvedTaskAssignee | null; disabled?: boolean }) {
  const { options, error } = useTaskAssignees(members);
  const choices = options.slice();
  if (current && !choices.some(option => option.id === current.id && option.type === current.type)) choices.push(current);
  return <div className="flex min-w-0 flex-col gap-1">
    <Combobox items={[{ value: "__none__", label: "Unassigned" }, ...choices.map(option => ({ value: assigneeValue(option), label: `${option.type === "AGENT" ? "Agents" : "People"} · ${option.displayName}${option.ownerName ? ` (${option.ownerName})` : ""}${option.type === "AGENT" ? ` · ${option.id.slice(0, 8)}` : ""}${option.available ? "" : " (unavailable)"}` }))]} value={assigneeValue(value)} onValueChange={next => onChange(assigneeFromValue(next))} disabled={disabled}>
      <ComboboxTrigger id={id} aria-label={id ? undefined : "Assignee"} className="w-full min-w-0 [&>[data-slot=combobox-value]]:block"><ComboboxValue placeholder="Unassigned" className="min-w-0 truncate" /></ComboboxTrigger>
      <ComboboxContent inputPlaceholder="Search people and agents…" className="min-w-0 max-w-[calc(100vw-2rem)] [&_[data-slot=combobox-item]>span:first-child]:min-w-0 [&_[data-slot=combobox-item]>span:first-child]:shrink [&_[data-slot=combobox-item]>span:first-child]:whitespace-normal [&_[data-slot=combobox-item]>span:first-child]:[overflow-wrap:anywhere]" />
    </Combobox>
    {error && <p role="status" className="text-xs text-muted-foreground">{error}</p>}
  </div>;
}
