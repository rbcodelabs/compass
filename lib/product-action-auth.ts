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

export type ProductEntityKind = "experiment" | "opportunity" | "solution" | "objective" | "keyResult" | "okrCycle" | "squad" | "roadmapItem" | "task";

export async function requireProductEntity(kind: ProductEntityKind, entityId: string, expectedWorkspaceId?: string) {
  const id = await userId();
  const db = getPrisma();
  const workspace = { members: { some: { userId: id } } };
  const deny = () => new Error("Entity not found or access denied");
  if (kind === "objective") {
    // Objective carries its own workspace_id (migration 068); a NULL column
    // never matches the membership filter, so an un-backfilled row is denied.
    const row = await db.objective.findFirst({ where: { id: entityId, workspace }, select: { workspaceId: true } });
    if (!row || !row.workspaceId || (expectedWorkspaceId && row.workspaceId !== expectedWorkspaceId)) throw deny();
    return { workspaceId: row.workspaceId, opportunityId: null };
  }
  if (kind === "keyResult") {
    // A Key Result is scoped through its Objective's workspace_id.
    const row = await db.keyResult.findFirst({ where: { id: entityId, objective: { workspace } }, select: { objective: { select: { workspaceId: true } } } });
    const workspaceId = row?.objective.workspaceId;
    if (!row || !workspaceId || (expectedWorkspaceId && workspaceId !== expectedWorkspaceId)) throw deny();
    return { workspaceId, opportunityId: null };
  }
  if (kind === "okrCycle" || kind === "squad" || kind === "roadmapItem" || kind === "task") {
    const delegate = { okrCycle: db.oKRCycle, squad: db.squad, roadmapItem: db.roadmapItem, task: db.task }[kind] as unknown as {
      findFirst(args: { where: object; select: { workspaceId: true } }): Promise<{ workspaceId: string } | null>;
    };
    const row = await delegate.findFirst({ where: { id: entityId, workspace }, select: { workspaceId: true } });
    if (!row || (expectedWorkspaceId && row.workspaceId !== expectedWorkspaceId)) throw deny();
    return { workspaceId: row.workspaceId, opportunityId: null };
  }
  if (kind === "solution") {
    // Tenant scope is the Solution's own workspace_id. A NULL column never
    // matches the membership filter, so an un-backfilled row is denied.
    const row = await db.solution.findFirst({ where: { id: entityId, workspace }, select: { id: true, opportunityId: true, workspaceId: true } });
    if (!row || !row.workspaceId || (expectedWorkspaceId && row.workspaceId !== expectedWorkspaceId)) throw deny();
    return { workspaceId: row.workspaceId, opportunityId: row.opportunityId };
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
