import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import getPrisma from "@/lib/db";
import { TaskDetail } from "@/components/tasks/task-detail";
import { getWorkspaceContext, requireWorkspaceContext } from "@/lib/workspace";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; taskId: string }>;
}) {
  const { taskId, orgSlug, workspaceSlug } = await params;
  // Uses the raw resolver, not requireWorkspaceContext: metadata degrades to a
  // fallback title rather than redirecting or 404ing. The page component below
  // asks for the same context and gets it from the request memo — this file is
  // why the control flow lives in the callers instead of inside the cache.
  const ctx = await getWorkspaceContext(orgSlug, workspaceSlug);
  if (ctx.status !== "ok") return { title: "Task" };
  const workspace = ctx.workspace;
  const prisma = getPrisma();
  const task = await prisma.task.findFirst({ where: { id: taskId, workspaceId: workspace.id }, select: { title: true } });
  return { title: task?.title ?? "Task" };
}

type Props = {
  params: Promise<{ orgSlug: string; workspaceSlug: string; taskId: string }>;
};

// Thin route shell: auth + a light existence/scope check for the 404 and the
// page-level breadcrumb chrome (not part of the shared component — see
// TaskDetail's own "Parent task" Section for the in-panel hop). All the
// heavy per-field data (squads/members/linkableTargets/customFields/subtasks)
// is fetched client-side by TaskDetail itself via useEntityDetail("task", …),
// the same panel data source the sidebar uses — this route no longer
// duplicates that Prisma work.
export default async function TaskDetailPage({ params }: Props) {
  const { orgSlug, workspaceSlug, taskId } = await params;
  const prisma = getPrisma();

  const { workspace } = await requireWorkspaceContext(orgSlug, workspaceSlug);

  const task = await prisma.task.findFirst({
    where: { id: taskId, workspaceId: workspace.id },
    select: { id: true, parentTaskId: true },
  });
  if (!task) notFound();

  const boardPath = `/${orgSlug}/${workspaceSlug}/tasks`;

  return (
    <div className="min-h-full shrink-0 p-4 sm:p-6 md:p-8">
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

        <TaskDetail taskId={taskId} orgSlug={orgSlug} workspaceSlug={workspaceSlug} variant="page" />
      </div>
    </div>
  );
}
