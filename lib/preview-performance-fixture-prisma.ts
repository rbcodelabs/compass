import { Prisma, type PrismaClient } from "@prisma/client";
import {
  SEED_ORDER,
  type PreviewFixtureKind,
  type PreviewFixtureManifest,
  type PreviewFixtureRow,
  type PreviewFixtureStore,
} from "./preview-performance-fixture.ts";

function asData<T>(rows: readonly PreviewFixtureRow[]): T[] {
  return rows.map((row) => ({ ...row })) as T[];
}

function idSet(manifest: PreviewFixtureManifest, kind: PreviewFixtureKind): Set<string> {
  return new Set(manifest.plannedIds[kind]);
}

function requireAllowed(value: string | null, allowed: Set<string>, label: string, nullable = false): void {
  if (value === null && nullable) return;
  if (value === null || !allowed.has(value)) throw new Error(`Preview fixture ownership mismatch for ${label}`);
}

const RECOVERY_TABLES: Record<PreviewFixtureKind, string> = {
  users: "users", organizations: "organizations", organizationMembers: "organization_members",
  workspaces: "workspaces", workspaceMembers: "workspace_members", squads: "squads",
  okrCycles: "okr_cycles", objectives: "objectives", keyResults: "key_results",
  opportunities: "opportunities", solutions: "solutions", assumptions: "assumptions",
  evidence: "evidence", experiments: "experiments", roadmapItems: "roadmap_items",
  feedback: "feedback", tasks: "tasks", sessions: "sessions",
};

export class PrismaPreviewFixtureStore implements PreviewFixtureStore {
  private readonly prisma: PrismaClient | Prisma.TransactionClient;

  constructor(prisma: PrismaClient | Prisma.TransactionClient) {
    this.prisma = prisma;
  }

  async insert(kind: PreviewFixtureKind, rows: readonly PreviewFixtureRow[]): Promise<void> {
    switch (kind) {
      case "users": await this.prisma.user.createMany({ data: asData<Prisma.UserCreateManyInput>(rows) }); break;
      case "organizations": await this.prisma.organization.createMany({ data: asData<Prisma.OrganizationCreateManyInput>(rows) }); break;
      case "organizationMembers": await this.prisma.organizationMember.createMany({ data: asData<Prisma.OrganizationMemberCreateManyInput>(rows) }); break;
      case "workspaces": await this.prisma.workspace.createMany({ data: asData<Prisma.WorkspaceCreateManyInput>(rows) }); break;
      case "workspaceMembers": await this.prisma.workspaceMember.createMany({ data: asData<Prisma.WorkspaceMemberCreateManyInput>(rows) }); break;
      case "squads": await this.prisma.squad.createMany({ data: asData<Prisma.SquadCreateManyInput>(rows) }); break;
      case "okrCycles": await this.prisma.oKRCycle.createMany({ data: asData<Prisma.OKRCycleCreateManyInput>(rows) }); break;
      case "objectives": await this.prisma.objective.createMany({ data: asData<Prisma.ObjectiveCreateManyInput>(rows) }); break;
      case "keyResults": await this.prisma.keyResult.createMany({ data: asData<Prisma.KeyResultCreateManyInput>(rows) }); break;
      case "opportunities": await this.prisma.opportunity.createMany({ data: asData<Prisma.OpportunityCreateManyInput>(rows) }); break;
      case "solutions": await this.prisma.solution.createMany({ data: asData<Prisma.SolutionCreateManyInput>(rows) }); break;
      case "assumptions": await this.prisma.assumption.createMany({ data: asData<Prisma.AssumptionCreateManyInput>(rows) }); break;
      case "evidence": await this.prisma.evidence.createMany({ data: asData<Prisma.EvidenceCreateManyInput>(rows) }); break;
      case "experiments": await this.prisma.experiment.createMany({ data: asData<Prisma.ExperimentCreateManyInput>(rows) }); break;
      case "roadmapItems": await this.prisma.roadmapItem.createMany({ data: asData<Prisma.RoadmapItemCreateManyInput>(rows) }); break;
      case "feedback": await this.prisma.feedbackItem.createMany({ data: asData<Prisma.FeedbackItemCreateManyInput>(rows) }); break;
      case "tasks": await this.prisma.task.createMany({ data: asData<Prisma.TaskCreateManyInput>(rows) }); break;
      case "sessions": await this.prisma.session.createMany({ data: asData<Prisma.SessionCreateManyInput>(rows) }); break;
    }
  }

  async verifyOwnership(manifest: PreviewFixtureManifest): Promise<void> {
    const users = idSet(manifest, "users");
    const organizations = idSet(manifest, "organizations");
    const workspaces = idSet(manifest, "workspaces");
    const squads = idSet(manifest, "squads");
    const cycles = idSet(manifest, "okrCycles");
    const objectives = idSet(manifest, "objectives");
    const keyResults = idSet(manifest, "keyResults");
    const opportunities = idSet(manifest, "opportunities");
    const solutions = idSet(manifest, "solutions");
    const assumptions = idSet(manifest, "assumptions");
    const { runId, sentinel } = manifest.identity;

    const userRows = await this.prisma.user.findMany({ where: { id: { in: [...users] } }, select: { id: true, email: true } });
    const expectedEmails = new Map(manifest.plannedIds.users.map((id, index) => [
      id,
      index === 0 ? sentinel.ownerEmail : `${runId}-member-${index + 1}@performance.invalid`,
    ]));
    for (const row of userRows) if (row.email !== expectedEmails.get(row.id)) throw new Error("Preview fixture ownership mismatch for user email sentinel");

    const organizationRows = await this.prisma.organization.findMany({ where: { id: { in: [...organizations] } }, select: { id: true, slug: true } });
    for (const row of organizationRows) if (row.slug !== sentinel.organizationSlug) throw new Error("Preview fixture ownership mismatch for organization slug sentinel");

    const workspaceRows = await this.prisma.workspace.findMany({ where: { id: { in: [...workspaces] } }, select: { id: true, slug: true, organizationId: true } });
    for (const row of workspaceRows) {
      if (row.slug !== sentinel.workspaceSlug) throw new Error("Preview fixture ownership mismatch for workspace slug sentinel");
      requireAllowed(row.organizationId, organizations, "workspace organization");
    }

    const organizationMemberRows = await this.prisma.organizationMember.findMany({ where: { id: { in: manifest.plannedIds.organizationMembers } }, select: { organizationId: true, userId: true } });
    for (const row of organizationMemberRows) {
      requireAllowed(row.organizationId, organizations, "organization membership organization");
      requireAllowed(row.userId, users, "organization membership user");
    }
    const workspaceMemberRows = await this.prisma.workspaceMember.findMany({ where: { id: { in: manifest.plannedIds.workspaceMembers } }, select: { workspaceId: true, userId: true } });
    for (const row of workspaceMemberRows) {
      requireAllowed(row.workspaceId, workspaces, "workspace membership workspace");
      requireAllowed(row.userId, users, "workspace membership user");
    }
    const sessionRows = await this.prisma.session.findMany({ where: { id: { in: manifest.plannedIds.sessions } }, select: { userId: true } });
    for (const row of sessionRows) requireAllowed(row.userId, users, "session user");

    const squadRows = await this.prisma.squad.findMany({ where: { id: { in: [...squads] } }, select: { workspaceId: true } });
    for (const row of squadRows) requireAllowed(row.workspaceId, workspaces, "squad workspace");
    const cycleRows = await this.prisma.oKRCycle.findMany({ where: { id: { in: [...cycles] } }, select: { workspaceId: true } });
    for (const row of cycleRows) requireAllowed(row.workspaceId, workspaces, "OKR cycle workspace");
    const objectiveRows = await this.prisma.objective.findMany({ where: { id: { in: [...objectives] } }, select: { cycleId: true, squadId: true, parentKeyResultId: true } });
    for (const row of objectiveRows) {
      requireAllowed(row.cycleId, cycles, "objective cycle");
      requireAllowed(row.squadId, squads, "objective squad");
      if (row.parentKeyResultId !== null) throw new Error("Preview fixture ownership mismatch for objective parent key result");
    }
    const keyResultRows = await this.prisma.keyResult.findMany({ where: { id: { in: [...keyResults] } }, select: { objectiveId: true } });
    for (const row of keyResultRows) requireAllowed(row.objectiveId, objectives, "key result objective");
    const opportunityRows = await this.prisma.opportunity.findMany({ where: { id: { in: [...opportunities] } }, select: { workspaceId: true, squadId: true, linkedKeyResultId: true } });
    for (const row of opportunityRows) {
      requireAllowed(row.workspaceId, workspaces, "opportunity workspace");
      requireAllowed(row.squadId, squads, "opportunity squad");
      requireAllowed(row.linkedKeyResultId, keyResults, "opportunity key result");
    }
    const solutionRows = await this.prisma.solution.findMany({ where: { id: { in: [...solutions] } }, select: { opportunityId: true } });
    for (const row of solutionRows) requireAllowed(row.opportunityId, opportunities, "solution opportunity");
    const assumptionRows = await this.prisma.assumption.findMany({ where: { id: { in: [...assumptions] } }, select: { solutionId: true } });
    for (const row of assumptionRows) requireAllowed(row.solutionId, solutions, "assumption solution");
    const evidenceRows = await this.prisma.evidence.findMany({ where: { id: { in: manifest.plannedIds.evidence } }, select: { workspaceId: true, opportunityId: true, solutionId: true, assumptionId: true } });
    for (const row of evidenceRows) {
      requireAllowed(row.workspaceId, workspaces, "evidence workspace");
      requireAllowed(row.opportunityId, opportunities, "evidence opportunity");
      requireAllowed(row.solutionId, solutions, "evidence solution");
      requireAllowed(row.assumptionId, assumptions, "evidence assumption");
    }
    const experimentRows = await this.prisma.experiment.findMany({ where: { id: { in: manifest.plannedIds.experiments } }, select: { workspaceId: true, squadId: true, assumptionId: true } });
    for (const row of experimentRows) {
      requireAllowed(row.workspaceId, workspaces, "experiment workspace");
      requireAllowed(row.squadId, squads, "experiment squad");
      requireAllowed(row.assumptionId, assumptions, "experiment assumption");
    }
    const roadmapRows = await this.prisma.roadmapItem.findMany({ where: { id: { in: manifest.plannedIds.roadmapItems } }, select: { workspaceId: true, squadId: true, opportunityId: true, solutionId: true, keyResultId: true, experimentId: true, feedbackId: true } });
    for (const row of roadmapRows) {
      requireAllowed(row.workspaceId, workspaces, "roadmap workspace");
      requireAllowed(row.squadId, squads, "roadmap squad");
      requireAllowed(row.opportunityId, opportunities, "roadmap opportunity");
      requireAllowed(row.solutionId, solutions, "roadmap solution");
      requireAllowed(row.keyResultId, keyResults, "roadmap key result");
      if (row.experimentId !== null || row.feedbackId !== null) throw new Error("Preview fixture ownership mismatch for roadmap optional parents");
    }
    const feedbackRows = await this.prisma.feedbackItem.findMany({ where: { id: { in: manifest.plannedIds.feedback } }, select: { workspaceId: true, opportunityId: true } });
    for (const row of feedbackRows) {
      requireAllowed(row.workspaceId, workspaces, "feedback workspace");
      requireAllowed(row.opportunityId, opportunities, "feedback opportunity");
    }
    const taskRows = await this.prisma.task.findMany({ where: { id: { in: manifest.plannedIds.tasks } }, select: { workspaceId: true, squadId: true, parentTaskId: true } });
    for (const row of taskRows) {
      requireAllowed(row.workspaceId, workspaces, "task workspace");
      requireAllowed(row.squadId, squads, "task squad");
      if (row.parentTaskId !== null) throw new Error("Preview fixture ownership mismatch for task parent");
    }
  }

  async verifyExactRows(plan: { rows: Record<PreviewFixtureKind, PreviewFixtureRow[]> }, includeSessionCredentials = false): Promise<void> {
    for (const kind of SEED_ORDER) {
      await this.verifyExactRowsForIds(kind, plan.rows[kind], includeSessionCredentials);
    }
  }

  async verifyExactRowsForIds(kind: PreviewFixtureKind, expectedRows: readonly PreviewFixtureRow[], includeSessionCredentials = false): Promise<void> {
    const actualRows = await this.findRows(kind, expectedRows.map(({ id }) => id));
    const actualById = new Map(actualRows.map((row) => [String(row.id), row]));
    for (const expected of expectedRows) {
      const actual = actualById.get(expected.id);
      if (!actual) continue;
      for (const [key, expectedValue] of Object.entries(expected)) {
        // Cleanup/verify never receive credential material or its original
        // expiry. Session ownership is proven by deterministic ID + user.
        if (!includeSessionCredentials && kind === "sessions" && (key === "sessionToken" || key === "expires")) continue;
        const actualValue = actual[key];
        const normalizedExpected = expectedValue instanceof Date ? expectedValue.toISOString() : expectedValue;
        const normalizedActual = actualValue instanceof Date ? actualValue.toISOString() : actualValue;
        if (normalizedActual !== normalizedExpected) throw new Error(`Preview fixture ownership mismatch for ${kind}.${key}`);
      }
    }
  }

  private async findRows(kind: PreviewFixtureKind, ids: readonly string[]): Promise<Record<string, unknown>[]> {
    const where = { id: { in: [...ids] } };
    let rows: unknown[];
    switch (kind) {
      case "users": rows = await this.prisma.user.findMany({ where }); break;
      case "organizations": rows = await this.prisma.organization.findMany({ where }); break;
      case "organizationMembers": rows = await this.prisma.organizationMember.findMany({ where }); break;
      case "workspaces": rows = await this.prisma.workspace.findMany({ where }); break;
      case "workspaceMembers": rows = await this.prisma.workspaceMember.findMany({ where }); break;
      case "squads": rows = await this.prisma.squad.findMany({ where }); break;
      case "okrCycles": rows = await this.prisma.oKRCycle.findMany({ where }); break;
      case "objectives": rows = await this.prisma.objective.findMany({ where }); break;
      case "keyResults": rows = await this.prisma.keyResult.findMany({ where }); break;
      case "opportunities": rows = await this.prisma.opportunity.findMany({ where }); break;
      case "solutions": rows = await this.prisma.solution.findMany({ where }); break;
      case "assumptions": rows = await this.prisma.assumption.findMany({ where }); break;
      case "evidence": rows = await this.prisma.evidence.findMany({ where }); break;
      case "experiments": rows = await this.prisma.experiment.findMany({ where }); break;
      case "roadmapItems": rows = await this.prisma.roadmapItem.findMany({ where }); break;
      case "feedback": rows = await this.prisma.feedbackItem.findMany({ where }); break;
      case "tasks": rows = await this.prisma.task.findMany({ where }); break;
      case "sessions": rows = await this.prisma.session.findMany({ where }); break;
    }
    return rows as Record<string, unknown>[];
  }

  async deleteIds(kind: PreviewFixtureKind, ids: readonly string[]): Promise<void> {
    await this.deleteIdsWithCount(kind, ids);
  }

  async deleteIdsWithCount(kind: PreviewFixtureKind, ids: readonly string[]): Promise<number> {
    const where = { id: { in: [...ids] } };
    let result: { count: number };
    switch (kind) {
      case "users": result = await this.prisma.user.deleteMany({ where }); break;
      case "organizations": result = await this.prisma.organization.deleteMany({ where }); break;
      case "organizationMembers": result = await this.prisma.organizationMember.deleteMany({ where }); break;
      case "workspaces": result = await this.prisma.workspace.deleteMany({ where }); break;
      case "workspaceMembers": result = await this.prisma.workspaceMember.deleteMany({ where }); break;
      case "squads": result = await this.prisma.squad.deleteMany({ where }); break;
      case "okrCycles": result = await this.prisma.oKRCycle.deleteMany({ where }); break;
      case "objectives": result = await this.prisma.objective.deleteMany({ where }); break;
      case "keyResults": result = await this.prisma.keyResult.deleteMany({ where }); break;
      case "opportunities": result = await this.prisma.opportunity.deleteMany({ where }); break;
      case "solutions": result = await this.prisma.solution.deleteMany({ where }); break;
      case "assumptions": result = await this.prisma.assumption.deleteMany({ where }); break;
      case "evidence": result = await this.prisma.evidence.deleteMany({ where }); break;
      case "experiments": result = await this.prisma.experiment.deleteMany({ where }); break;
      case "roadmapItems": result = await this.prisma.roadmapItem.deleteMany({ where }); break;
      case "feedback": result = await this.prisma.feedbackItem.deleteMany({ where }); break;
      case "tasks": result = await this.prisma.task.deleteMany({ where }); break;
      case "sessions": result = await this.prisma.session.deleteMany({ where }); break;
    }
    return result.count;
  }

  async deleteIdsDirectWithCount(kind: PreviewFixtureKind, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    // The recovery route has already proven every row and deletes in explicit
    // dependency order. A direct DSQL delete avoids Prisma relationMode=prisma
    // traversing unrelated Workspace relations that are not part of the fixture.
    const table = Prisma.raw(`"compass_preview"."${RECOVERY_TABLES[kind]}"`);
    return this.prisma.$executeRaw(Prisma.sql`DELETE FROM ${table} WHERE "id" IN (${Prisma.join([...ids])})`);
  }

  async countResidue(manifest: PreviewFixtureManifest): Promise<number> {
    const counts = await Promise.all(SEED_ORDER.map((kind) => this.countKind(kind, manifest.plannedIds[kind])));
    const sentinelCount = await this.countSentinelRows(manifest);
    return counts.reduce((total, count) => total + count, sentinelCount);
  }

  async countSentinelRows(manifest: PreviewFixtureManifest): Promise<number> {
    const uniqueSentinelCounts = await Promise.all([
      this.prisma.user.count({ where: { email: { in: manifest.plannedIds.users.map((_id, index) => index === 0
        ? manifest.identity.sentinel.ownerEmail
        : `${manifest.identity.runId}-member-${index + 1}@performance.invalid`) } } }),
      this.prisma.organization.count({ where: { slug: manifest.identity.sentinel.organizationSlug } }),
      this.prisma.workspace.count({ where: { slug: manifest.identity.sentinel.workspaceSlug } }),
    ]);
    return uniqueSentinelCounts.reduce((total, count) => total + count, 0);
  }

  async countPlannedRows(manifest: PreviewFixtureManifest): Promise<number> {
    const counts = await Promise.all(SEED_ORDER.map((kind) => this.countKind(kind, manifest.plannedIds[kind])));
    return counts.reduce((total, count) => total + count, 0);
  }

  async countPlannedRowsByKind(manifest: PreviewFixtureManifest): Promise<Record<PreviewFixtureKind, number>> {
    return Object.fromEntries(await Promise.all(SEED_ORDER.map(async (kind) => [kind, await this.countKind(kind, manifest.plannedIds[kind])]))) as Record<PreviewFixtureKind, number>;
  }

  async countIds(kind: PreviewFixtureKind, ids: readonly string[]): Promise<number> {
    return this.countKind(kind, ids);
  }

  private async countKind(kind: PreviewFixtureKind, ids: readonly string[]): Promise<number> {
    const where = { id: { in: [...ids] } };
    switch (kind) {
      case "users": return this.prisma.user.count({ where });
      case "organizations": return this.prisma.organization.count({ where });
      case "organizationMembers": return this.prisma.organizationMember.count({ where });
      case "workspaces": return this.prisma.workspace.count({ where });
      case "workspaceMembers": return this.prisma.workspaceMember.count({ where });
      case "squads": return this.prisma.squad.count({ where });
      case "okrCycles": return this.prisma.oKRCycle.count({ where });
      case "objectives": return this.prisma.objective.count({ where });
      case "keyResults": return this.prisma.keyResult.count({ where });
      case "opportunities": return this.prisma.opportunity.count({ where });
      case "solutions": return this.prisma.solution.count({ where });
      case "assumptions": return this.prisma.assumption.count({ where });
      case "evidence": return this.prisma.evidence.count({ where });
      case "experiments": return this.prisma.experiment.count({ where });
      case "roadmapItems": return this.prisma.roadmapItem.count({ where });
      case "feedback": return this.prisma.feedbackItem.count({ where });
      case "tasks": return this.prisma.task.count({ where });
      case "sessions": return this.prisma.session.count({ where });
    }
  }
}

export function previewFixtureStoreKinds(): readonly PreviewFixtureKind[] {
  return SEED_ORDER;
}
