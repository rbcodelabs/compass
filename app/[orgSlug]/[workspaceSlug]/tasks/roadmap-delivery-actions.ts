"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { getWorkspace } from "@/lib/workspace";

async function requireRoadmapWorkspace(orgSlug: string, workspaceSlug: string, roadmapItemId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) throw new Error("Not found");
  const item = await getPrisma().roadmapItem.findFirst({ where: { id: roadmapItemId, workspaceId: workspace.id }, select: { id: true } });
  if (!item) throw new Error("Not found");
  return workspace;
}

export async function addRoadmapDeliveryTask(orgSlug: string, workspaceSlug: string, roadmapItemId: string, data: { title: string; assigneeUserId?: string | null }) {
  const workspace = await requireRoadmapWorkspace(orgSlug, workspaceSlug, roadmapItemId);
  const title = data.title.trim();
  if (!title) throw new Error("Title is required");
  if (data.assigneeUserId) {
    const member = await getPrisma().workspaceMember.findFirst({ where: { workspaceId: workspace.id, userId: data.assigneeUserId }, select: { id: true } });
    if (!member) throw new Error("Assignee is not in this workspace");
  }
  const lastTask = await getPrisma().task.findFirst({ where: { workspaceId: workspace.id, status: "TODO" }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const task = await getPrisma().task.create({
    data: { workspaceId: workspace.id, title, status: "TODO", priority: "MEDIUM", assigneeUserId: data.assigneeUserId, sortOrder: lastTask ? lastTask.sortOrder + 1 : 0, links: { create: { linkedType: "ROADMAP_ITEM", linkedId: roadmapItemId } } },
  });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/roadmap`);
  return task;
}

export async function linkRoadmapDeliveryTask(orgSlug: string, workspaceSlug: string, roadmapItemId: string, taskId: string) {
  const workspace = await requireRoadmapWorkspace(orgSlug, workspaceSlug, roadmapItemId);
  const task = await getPrisma().task.findFirst({ where: { id: taskId, workspaceId: workspace.id, status: { not: "CANCELLED" } }, select: { id: true } });
  if (!task) throw new Error("Not found");
  const link = await getPrisma().taskLink.upsert({ where: { taskId_linkedType_linkedId: { taskId, linkedType: "ROADMAP_ITEM", linkedId: roadmapItemId } }, create: { taskId, linkedType: "ROADMAP_ITEM", linkedId: roadmapItemId }, update: {} });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/roadmap`);
  return link;
}
