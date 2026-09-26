import { auth } from "@/auth";
import getPrisma from "@/lib/db";

async function userId() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user.id;
}

export async function requireProductWorkspace(workspaceId: string) {
  const id = await userId();
  const row = await getPrisma().workspace.findFirst({ where: { id: workspaceId, members: { some: { userId: id } } }, select: { id: true } });
  if (!row) throw new Error("Workspace not found or access denied");
  return row.id;
}

export async function requireProductEntity(kind: "experiment" | "opportunity" | "solution", entityId: string, expectedWorkspaceId?: string) {
  const id = await userId();
  const db = getPrisma();
  const workspace = { members: { some: { userId: id } } };
  if (kind === "solution") {
    const row = await db.solution.findFirst({ where: { id: entityId, opportunity: { workspace } }, select: { id: true, opportunityId: true, opportunity: { select: { workspaceId: true } } } });
    if (!row || (expectedWorkspaceId && row.opportunity.workspaceId !== expectedWorkspaceId)) throw new Error("Entity not found or access denied");
    return { workspaceId: row.opportunity.workspaceId, opportunityId: row.opportunityId };
  }
  const row = kind === "experiment"
    ? await db.experiment.findFirst({ where: { id: entityId, workspace }, select: { workspaceId: true } })
    : await db.opportunity.findFirst({ where: { id: entityId, workspace }, select: { workspaceId: true } });
  if (!row || (expectedWorkspaceId && row.workspaceId !== expectedWorkspaceId)) throw new Error("Entity not found or access denied");
  return { workspaceId: row.workspaceId, opportunityId: null };
}

/**
 * Slug-addressed variant of requireProductWorkspace, for client surfaces that
 * only know the URL (the composer panels). Membership is part of the lookup:
 * a server action is a public POST endpoint, so a guessable slug pair must
 * never be enough to write into a workspace.
 */
export async function requireProductWorkspaceBySlug(orgSlug: string, workspaceSlug: string) {
  const id = await userId();
  const row = await getPrisma().workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: id } } },
    select: { id: true },
  });
  if (!row) throw new Error("Workspace not found or access denied");
  return row.id;
}
