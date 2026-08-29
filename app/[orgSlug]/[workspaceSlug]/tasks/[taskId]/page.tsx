import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TaskHeader } from "@/components/tasks/task-header";
import { SubtasksPanel } from "@/components/tasks/subtasks-panel";
import { TaskLinksPanel } from "@/components/tasks/task-links-panel";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import type { LinkableTargets } from "@/components/tasks/link-task-dialog";
import type { TaskCardData } from "@/components/tasks/task-card";
import type {
  TaskStatus,
  TaskPriority,
  TaskLinkedType,
  SquadData,
  MemberData,
  CustomFieldDefinitionData,
  CustomFieldType,
  CustomFieldValue,
} from "@/lib/types";
import { normalizeWorkspaceRole } from "@/lib/roles";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; taskId: string }>;
}) {
  const { taskId } = await params;
  const prisma = getPrisma();
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { title: true } });
  return { title: task?.title ?? "Task" };
}

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; taskId: string }>;
};

export default async function TaskDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { orgSlug, workspaceSlug, taskId } = await params;
  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) notFound();

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: workspace.id },
    include: {
      squad: { select: { id: true, name: true, color: true } },
      links: true,
      subtasks: {
        orderBy: { sortOrder: "asc" },
        include: { squad: { select: { id: true, name: true, color: true } }, links: true, _count: { select: { subtasks: true } } },
      },
    },
  });
  if (!task) notFound();

  const [rawSquads, rawMembers, fieldDefs] = await Promise.all([
    prisma.squad.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
    prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customFieldDefinition.findMany({ where: { workspaceId: workspace.id, objectType: "TASK" }, orderBy: { order: "asc" } }),
  ]);

  const squads: SquadData[] = rawSquads.map((s) => ({ id: s.id, name: s.name, color: s.color }));
  const members: MemberData[] = rawMembers.map((m) => ({
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: normalizeWorkspaceRole(m.role),
  }));

  // Batch-resolve titles for this task's own links.
  const linksByType = new Map<string, string[]>();
  for (const link of task.links) {
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
        where: { id: { in: ids } },
        select: { id: true, title: true },
      });
      for (const row of rows) titleById.set(`${linkedType}:${row.id}`, row.title);
    })
  );

  // Candidate pools for the "link to another item" dialog — same shape used
  // by the roadmap add-item form's availableX lists.
  const [opps, sols, roadmapItems, objectives, keyResults, docs, experiments, feedbackItems] = await Promise.all([
    prisma.opportunity.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.solution.findMany({ where: { opportunity: { workspaceId: workspace.id } }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.roadmapItem.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.objective.findMany({ where: { cycle: { workspaceId: workspace.id } }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.keyResult.findMany({ where: { objective: { cycle: { workspaceId: workspace.id } } }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.doc.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.experiment.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
    prisma.feedbackItem.findMany({ where: { workspaceId: workspace.id }, select: { id: true, title: true }, orderBy: { createdAt: "asc" } }),
  ]);

  const linkableTargets: LinkableTargets = {
    OPPORTUNITY: opps,
    SOLUTION: sols,
    ROADMAP_ITEM: roadmapItems,
    OBJECTIVE: objectives,
    KEY_RESULT: keyResults,
    DOC: docs,
    EXPERIMENT: experiments,
    FEEDBACK_ITEM: feedbackItems,
  };

  const taskCard: TaskCardData = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
    sortOrder: task.sortOrder,
    squadId: task.squadId,
    squad: task.squad,
    assigneeUserId: task.assigneeUserId,
    ownerName: task.ownerName,
    storyPoints: task.storyPoints,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    iteration: task.iteration,
    parentTaskId: task.parentTaskId,
    subtaskCount: task.subtasks.length,
    links: task.links.map((l) => ({
      id: l.id,
      linkedType: l.linkedType as TaskLinkedType,
      linkedId: l.linkedId,
      linkedTitle: titleById.get(`${l.linkedType}:${l.linkedId}`) ?? "(deleted)",
    })),
  };

  const subtaskCards: TaskCardData[] = task.subtasks.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    status: s.status as TaskStatus,
    priority: s.priority as TaskPriority,
    sortOrder: s.sortOrder,
    squadId: s.squadId,
    squad: s.squad,
    assigneeUserId: s.assigneeUserId,
    ownerName: s.ownerName,
    storyPoints: s.storyPoints,
    dueDate: s.dueDate ? s.dueDate.toISOString() : null,
    iteration: s.iteration,
    parentTaskId: s.parentTaskId,
    subtaskCount: s._count.subtasks,
    links: [],
  }));

  const fieldValues = fieldDefs.length > 0
    ? await prisma.customFieldValue.findMany({
        where: { fieldId: { in: fieldDefs.map((f) => f.id) }, objectId: taskId },
      })
    : [];
  const valueByFieldId = new Map(fieldValues.map((v) => [v.fieldId, v.value]));
  const customFields: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }> = fieldDefs.map((f) => ({
    id: f.id,
    name: f.name,
    fieldType: f.fieldType as CustomFieldType,
    objectType: "TASK" as const,
    options: f.options as CustomFieldDefinitionData["options"],
    required: f.required,
    order: f.order,
    currentValue: (valueByFieldId.get(f.id) ?? null) as CustomFieldValue,
  }));
  const hasCustomFields = customFields.length > 0;

  const boardPath = `/${orgSlug}/${workspaceSlug}/tasks`;
  const detailPath = `/${orgSlug}/${workspaceSlug}/tasks/${taskId}`;

  return (
    <div className="min-h-full p-4 sm:p-6 md:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={boardPath} className="flex items-center gap-1 hover:text-foreground transition-colors">
            <ChevronLeftIcon className="size-4" />
            Tasks
          </Link>
          {task.parentTaskId && (
            <>
              <span>/</span>
              <Link href={`${boardPath}/${task.parentTaskId}`} className="hover:text-foreground transition-colors">
                Parent task
              </Link>
            </>
          )}
        </div>

        <TaskHeader task={taskCard} workspaceId={workspace.id} squads={squads} members={members} revalidatePathStr={detailPath} />

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="subtasks">Subtasks ({task.subtasks.length})</TabsTrigger>
            <TabsTrigger value="links">Links ({task.links.length})</TabsTrigger>
            {hasCustomFields && <TabsTrigger value="details">Details</TabsTrigger>}
          </TabsList>

          <TabsContent value="overview" className="flex flex-col gap-3 pt-4 text-sm">
            <div className="grid grid-cols-2 gap-4 max-w-md">
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <p className="font-medium">{task.status}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Priority</p>
                <p className="font-medium">{task.priority}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Iteration</p>
                <p className="font-medium">{task.iteration ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Story points</p>
                <p className="font-medium">{task.storyPoints ?? "—"}</p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="subtasks" className="pt-4">
            <SubtasksPanel
              workspaceId={workspace.id}
              parentTaskId={taskId}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              members={members}
              initialSubtasks={subtaskCards}
              revalidatePathStr={detailPath}
            />
          </TabsContent>

          <TabsContent value="links" className="pt-4">
            <TaskLinksPanel
              taskId={taskId}
              initialLinks={taskCard.links}
              revalidatePathStr={detailPath}
              linkableTargets={linkableTargets}
            />
          </TabsContent>

          {hasCustomFields && (
            <TabsContent value="details" className="pt-4">
              <div className="max-w-xl">
                <CustomFieldsPanel fields={customFields} objectId={taskId} revalidatePathStr={detailPath} />
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
