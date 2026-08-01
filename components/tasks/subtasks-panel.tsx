"use client";

import { useState } from "react";
import { TaskListView } from "./task-list-view";
import { AddSubtaskForm } from "./add-subtask-form";
import type { TaskCardData } from "./task-card";
import type { MemberData } from "@/lib/types";

type Props = {
  workspaceId: string;
  parentTaskId: string;
  orgSlug: string;
  workspaceSlug: string;
  members: MemberData[];
  initialSubtasks: TaskCardData[];
  revalidatePathStr: string;
};

export function SubtasksPanel({
  workspaceId,
  parentTaskId,
  orgSlug,
  workspaceSlug,
  members,
  initialSubtasks,
  revalidatePathStr,
}: Props) {
  const [subtasks, setSubtasks] = useState(initialSubtasks);

  return (
    <div className="flex flex-col gap-3">
      {subtasks.length > 0 && (
        <TaskListView tasks={subtasks} orgSlug={orgSlug} workspaceSlug={workspaceSlug} members={members} />
      )}
      <AddSubtaskForm
        workspaceId={workspaceId}
        parentTaskId={parentTaskId}
        revalidatePathStr={revalidatePathStr}
        onAdd={(task) => setSubtasks((prev) => [...prev, task])}
      />
    </div>
  );
}
