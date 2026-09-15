"use client";

/**
 * Inline assignee editor for TaskDetail: TaskAssigneePicker (the same
 * click-to-open Combobox over people *and* agents used by AddSubtaskForm),
 * writing the `assignee` union field, plus an EditableText fallback for the
 * freeform `ownerName` (external stakeholder) field — same dual-field shape
 * EditTaskDialog had, just inline instead of in a dialog.
 */
import { useState } from "react";
import { TaskAssigneePicker } from "./task-assignee-picker";
import { EditableText, patchEntityField, type EditContext } from "@/components/panels/panel-parts";
import type { TaskAssignee, ResolvedTaskAssignee } from "@/lib/task-assignment";
import type { MemberData } from "@/lib/types";

type Props = {
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  /** Resolved display data for the current assignee, if available — lets the
   * picker keep showing a historical/unavailable assignee that isn't in the
   * eligible options list. */
  current?: ResolvedTaskAssignee | null;
  ownerName: string | null;
  members: MemberData[];
  edit: EditContext;
};

export function InlineAssigneeField({ assigneeUserId, assigneeAgentId, current, ownerName, members, edit }: Props) {
  const [saving, setSaving] = useState(false);
  const value: TaskAssignee = assigneeAgentId
    ? { type: "AGENT", id: assigneeAgentId }
    : assigneeUserId
      ? { type: "USER", id: assigneeUserId }
      : null;

  async function handleChange(next: TaskAssignee) {
    if (next?.type === value?.type && next?.id === value?.id) return;
    setSaving(true);
    try {
      const res = await patchEntityField(edit.type, edit.id, edit.orgSlug, edit.workspaceSlug, "assignee", next);
      edit.onSaved(res.data);
    } catch {
      // leave as-is on failure
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <TaskAssigneePicker members={members} value={value} onChange={handleChange} current={current} disabled={saving} />
      <EditableText
        value={ownerName}
        field="ownerName"
        edit={edit}
        placeholder="Or an external owner name…"
        className="text-sm"
      />
    </div>
  );
}
