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

type Db = ReturnType<typeof getPrisma>;
type Membership = { members: { some: { userId: string } } };
type Found = { workspaceId: string | null; opportunityId?: string } | null;

/**
 * One typed lookup per kind. Membership is part of the query, so a foreign row
 * is "not found". Each branch names its own Prisma model and relation, so a
 * rename is a tsc error here instead of a silent miss behind an `as unknown`
 * cast. `satisfies` makes adding a kind to ProductEntityKind without a lookup
 * a compile error too.
 *
 * Solution and Objective carry their own workspace_id (migration 068) and a
 * NULL column never reaches a caller: requireProductEntity rejects it below.
 * Key Result scopes through its Objective.
 */
const LOOKUPS = {
  experiment: (db: Db, id: string, workspace: Membership): Promise<Found> => db.experiment.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
  opportunity: (db: Db, id: string, workspace: Membership): Promise<Found> => db.opportunity.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
  solution: (db: Db, id: string, workspace: Membership): Promise<Found> => db.solution.findFirst({ where: { id, workspace }, select: { opportunityId: true, workspaceId: true } }),
  objective: (db: Db, id: string, workspace: Membership): Promise<Found> => db.objective.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
  keyResult: async (db: Db, id: string, workspace: Membership): Promise<Found> => {
    const row = await db.keyResult.findFirst({ where: { id, objective: { workspace } }, select: { objective: { select: { workspaceId: true } } } });
    return row && { workspaceId: row.objective.workspaceId };
  },
  okrCycle: (db: Db, id: string, workspace: Membership): Promise<Found> => db.oKRCycle.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
  squad: (db: Db, id: string, workspace: Membership): Promise<Found> => db.squad.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
  roadmapItem: (db: Db, id: string, workspace: Membership): Promise<Found> => db.roadmapItem.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
  task: (db: Db, id: string, workspace: Membership): Promise<Found> => db.task.findFirst({ where: { id, workspace }, select: { workspaceId: true } }),
} satisfies Record<ProductEntityKind, (db: Db, id: string, workspace: Membership) => Promise<Found>>;

export async function requireProductEntity(kind: ProductEntityKind, entityId: string, expectedWorkspaceId?: string) {
  const id = await userId();
  const found = await LOOKUPS[kind](getPrisma(), entityId, { members: { some: { userId: id } } });
  // A NULL workspaceId (row not yet backfilled) fails closed, never allowed.
  if (!found || !found.workspaceId || (expectedWorkspaceId && found.workspaceId !== expectedWorkspaceId)) throw new Error("Entity not found or access denied");
  return { workspaceId: found.workspaceId, opportunityId: found.opportunityId ?? null };
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
