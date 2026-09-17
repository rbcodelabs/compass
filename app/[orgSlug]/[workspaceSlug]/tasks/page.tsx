import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskListView } from "@/components/tasks/task-list-view";
import { TasksViewToggle } from "@/components/tasks/tasks-view-toggle";
import { TasksFilters } from "@/components/tasks/tasks-filters";
import type { TaskCardData } from "@/components/tasks/task-card";
import type { SquadData, MemberData } from "@/lib/types";
import { normalizeWorkspaceRole } from "@/lib/roles";
import { WorkspacePage } from "@/components/patterns/workspace-page";
import { buildTaskCards } from "@/lib/task-read-model";
import { getWorkspace } from "@/lib/workspace";
import { taskBoardFilterKey } from "@/lib/task-filters";
import { parseAssigneeFilter, resolveTaskAssignees, taskLinkScope } from "@/lib/task-assignment";
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions";
import {
  buildCustomFieldFilterGroups,
  parseCustomFieldFilterParams,
  resolveCustomFieldFilter,
} from "@/lib/custom-field-filter";

export const metadata = {
  title: "Tasks",
};

interface TasksPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{
    squad?: string;
    assignee?: string;
    priority?: string;
    view?: string;
    field?: string;
    fieldValue?: string;
  }>;
}

export default async function TasksPage({ params, searchParams }: TasksPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const {
    squad: squadFilter,
    assignee: assigneeFilter,
    priority: priorityFilter,
    view: viewParam,
    field: fieldParam,
    fieldValue: fieldValueParam,
  } = await searchParams;
  const view = viewParam === "list" ? "list" : "board";
  const prisma = getPrisma();

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) notFound();

  // Custom-field tag filter. `null` means "no filter applied" (including a
  // filter carried over from another page with no counterpart here); an empty
  // id list means the filter applied and nothing matched.
  const [taskFieldDefs, customFieldFilter] = await Promise.all([
    loadCustomFieldDefinitions(prisma, { workspaceId: workspace.id, objectTypes: ["TASK"] }),
    resolveCustomFieldFilter(prisma, {
      workspaceId: workspace.id,
      objectTypes: ["TASK"],
      filter: parseCustomFieldFilterParams({ field: fieldParam, fieldValue: fieldValueParam }),
    }),
  ]);
  const customFieldGroups = buildCustomFieldFilterGroups(taskFieldDefs);

  const [rawSquads, rawTasks, rawMembers] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
    prisma.task.findMany({
      where: {
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
        ...parseAssigneeFilter(assigneeFilter),
        ...(priorityFilter ? { priority: priorityFilter } : {}),
        ...(customFieldFilter ? { id: { in: customFieldFilter.objectIds } } : {}),
      },
      orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
      select: {
        id: true, title: true, description: true, status: true, priority: true,
        sortOrder: true, squadId: true, assigneeUserId: true, assigneeAgentId: true, ownerName: true,
        storyPoints: true, dueDate: true, iteration: true, parentTaskId: true,
      },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const squads: SquadData[] = rawSquads.map((s) => ({ id: s.id, name: s.name, color: s.color }));

  const members: MemberData[] = rawMembers.map((m) => ({
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: normalizeWorkspaceRole(m.role),
  }));

  const taskIds = rawTasks.map((task) => task.id);
  const [taskLinks, subtaskCounts] = taskIds.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.taskLink.findMany({ where: { taskId: { in: taskIds } }, orderBy: { createdAt: "asc" } }),
        prisma.task.groupBy({
          by: ["parentTaskId"],
          where: { workspaceId: workspace.id, parentTaskId: { in: taskIds } },
          _count: { _all: true },
        }),
      ]);

  // Batch-resolve linked-object titles across all tasks on this page, grouped
  // by linkedType, mirroring the resolver used by the MCP handlers — a single
  // page load can touch many linkedTypes at once, so this avoids N+1 queries.
  const linksByType = new Map<string, string[]>();
  for (const link of taskLinks) {
    const ids = linksByType.get(link.linkedType) ?? [];
    ids.push(link.linkedId);
    linksByType.set(link.linkedType, ids);
  }
  const LINK_MODEL = {
    OPPORTUNITY: prisma.opportunity,
    SOLUTION: prisma.solution,
    ROADMAP_ITEM: prisma.roadmapItem,
    OBJECTIVE: prisma.objective,
    KEY_RESULT: prisma.keyResult,
    DOC: prisma.doc,
    EXPERIMENT: prisma.experiment,
    FEEDBACK_ITEM: prisma.feedbackItem,
  } as const;
  const titleById = new Map<string, string>();
  await Promise.all(
    Array.from(linksByType.entries()).map(async ([linkedType, ids]) => {
      const delegate = LINK_MODEL[linkedType as keyof typeof LINK_MODEL];
      if (!delegate) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: { id: string; title: string }[] = await (delegate as any).findMany({
        where: { id: { in: ids }, ...taskLinkScope(workspace.id, linkedType) },
        select: { id: true, title: true },
      });
      for (const row of rows) titleById.set(`${linkedType}:${row.id}`, row.title);
    })
  );

  const tasks: TaskCardData[] = buildTaskCards({
    tasks: await resolveTaskAssignees(workspace.id, rawTasks), squads, links: taskLinks, subtaskCounts, linkedTitles: titleById,
  });

  return (
    <WorkspacePage
      title="Tasks"
      contentClassName={view === "board" ? "p-0 sm:p-0 md:p-0" : undefined}
      actions={(
        <Suspense>
          <TasksFilters
            squads={squads}
            members={members}
            customFieldGroups={customFieldGroups}
            activeCustomFieldId={customFieldFilter?.fieldId ?? null}
          />
          <TasksViewToggle view={view} />
        </Suspense>
      )}
    >
      {view === "list" ? (
        <TaskListView tasks={tasks} orgSlug={orgSlug} workspaceSlug={workspaceSlug} members={members} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/*
            The board seeds its column state on mount and is intentionally not
            reactive to `initialTasks`, so that optimistic drag-and-drop
            survives revalidation. Keying it on the active filters remounts it
            when — and only when — the filter changes, which is the one moment
            the client should drop its optimistic state and show server truth.
          */}
          <TaskBoard
            key={taskBoardFilterKey({
              squad: squadFilter,
              assignee: assigneeFilter,
              priority: priorityFilter,
              field: customFieldFilter?.fieldId,
              fieldValue: fieldValueParam,
            })}
            initialTasks={tasks}
            workspaceId={workspace.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            members={members}
          />
        </div>
      )}
    </WorkspacePage>
  );
}
