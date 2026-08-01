import { Suspense } from "react";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import getPrisma from "@/lib/db";
import { TaskBoard } from "@/components/tasks/task-board";
import { TaskListView } from "@/components/tasks/task-list-view";
import { TasksViewToggle } from "@/components/tasks/tasks-view-toggle";
import { SquadFilterBar } from "@/components/squads/squad-filter-bar";
import { AssigneeFilterBar, PriorityFilterBar } from "@/components/tasks/assignee-filter-bar";
import type { TaskCardData } from "@/components/tasks/task-card";
import type { TaskStatus, TaskPriority, SquadData, MemberData } from "@/lib/types";

export const metadata = {
  title: "Tasks",
};

interface TasksPageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ squad?: string; assignee?: string; priority?: string; view?: string }>;
}

export default async function TasksPage({ params, searchParams }: TasksPageProps) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug } = await params;
  const { squad: squadFilter, assignee: assigneeFilter, priority: priorityFilter, view: viewParam } = await searchParams;
  const view = viewParam === "list" ? "list" : "board";
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
  });
  if (!workspace) notFound();

  const [rawSquads, rawTasks, rawMembers] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
    prisma.task.findMany({
      where: {
        workspaceId: workspace.id,
        ...(squadFilter ? { squadId: squadFilter } : {}),
        ...(assigneeFilter ? { assigneeUserId: assigneeFilter } : {}),
        ...(priorityFilter ? { priority: priorityFilter } : {}),
      },
      orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
      include: {
        squad: { select: { id: true, name: true, color: true } },
        links: true,
        _count: { select: { subtasks: true } },
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
    role: m.role as MemberData["role"],
  }));

  // Batch-resolve linked-object titles across all tasks on this page, grouped
  // by linkedType, mirroring the resolver used by the MCP handlers — a single
  // page load can touch many linkedTypes at once, so this avoids N+1 queries.
  const linksByType = new Map<string, string[]>();
  for (const task of rawTasks) {
    for (const link of task.links) {
      const ids = linksByType.get(link.linkedType) ?? [];
      ids.push(link.linkedId);
      linksByType.set(link.linkedType, ids);
    }
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
        where: { id: { in: ids } },
        select: { id: true, title: true },
      });
      for (const row of rows) titleById.set(`${linkedType}:${row.id}`, row.title);
    })
  );

  const tasks: TaskCardData[] = rawTasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status as TaskStatus,
    priority: t.priority as TaskPriority,
    sortOrder: t.sortOrder,
    squadId: t.squadId,
    squad: t.squad,
    assigneeUserId: t.assigneeUserId,
    ownerName: t.ownerName,
    storyPoints: t.storyPoints,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    iteration: t.iteration,
    parentTaskId: t.parentTaskId,
    subtaskCount: t._count.subtasks,
    links: t.links.map((l) => ({
      id: l.id,
      linkedType: l.linkedType as TaskCardData["links"][number]["linkedType"],
      linkedId: l.linkedId,
      linkedTitle: titleById.get(`${l.linkedType}:${l.linkedId}`) ?? "(deleted)",
    })),
  }));

  return (
    <div className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6 min-h-0">
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900">Tasks</h1>
          <p className="text-slate-500 text-sm mt-1">
            {view === "list"
              ? "A flat, filterable list — good for tracking a handful of high-priority initiatives."
              : "Drag tasks between columns to update status. Blocked is its own column."}
          </p>
        </div>
        <Suspense>
          <TasksViewToggle view={view} />
        </Suspense>
      </div>

      <div className="shrink-0 flex flex-col gap-2">
        <Suspense>
          <SquadFilterBar squads={squads} />
        </Suspense>
        <Suspense>
          <AssigneeFilterBar members={members} />
        </Suspense>
        <Suspense>
          <PriorityFilterBar />
        </Suspense>
      </div>

      {view === "list" ? (
        <TaskListView tasks={tasks} orgSlug={orgSlug} workspaceSlug={workspaceSlug} members={members} />
      ) : (
        <div className="overflow-x-auto min-w-0">
          <TaskBoard
            initialTasks={tasks}
            workspaceId={workspace.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            members={members}
          />
        </div>
      )}
    </div>
  );
}
