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
        /* `natural`, not `fill`: this panel sits in a normally-scrolling
           column, where a `flex-1 min-h-0` grid would have no height to claim. */
        <TaskListView
          tasks={subtasks}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          members={members}
          height="natural"
          gridId="task-subtasks"
        />
      )}
      <AddSubtaskForm
        members={members}
        workspaceId={workspaceId}
        parentTaskId={parentTaskId}
        revalidatePathStr={revalidatePathStr}
        onAdd={(task) => setSubtasks((prev) => [...prev, task])}
      />
    </div>
  );
}
