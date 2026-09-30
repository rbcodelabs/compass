/**
 * A tiny in-memory stand-in for the Prisma client, seeded with two tenants, for
 * cross-tenant regression tests.
 *
 * Unlike a `findFirst: vi.fn()` stub, this honours the `where` clauses the code
 * under test actually sends (slug + organization slug + membership, and
 * `workspaceId` bindings). A missing or wrong filter therefore shows up as a
 * real read or a real mutation of the *other* tenant's rows, not as a mock that
 * happens to return whatever the test told it to.
 *
 * Only the query shapes the authorization seams use are implemented; anything
 * else throws so an unexpected query cannot silently pass.
 */

export const USERS = {
  /** Member of workspace A only. */
  alice: "user-alice",
  /** Member of workspace B only. */
  bob: "user-bob",
  /** Signed in, but a member of neither workspace. */
  eve: "user-eve",
} as const;

export const WS_A = { id: "ws-a", org: "acme", slug: "alpha" } as const;
export const WS_B = { id: "ws-b", org: "globex", slug: "beta" } as const;

type FeedbackRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  type: string;
  opportunityId: string | null;
  updatedAt: Date | null;
};
type OpportunityRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  squadId: string | null;
  linkedKeyResultId: string | null;
  sortOrder: number;
  createdAt: Date;
};
type Graph = Record<string, unknown>;
type SquadRow = { id: string; workspaceId: string; name: string; color: string; createdAt: Date };

export function createTenantFakePrisma() {
  const workspaces = [
    { ...WS_A, members: [USERS.alice] as string[] },
    { ...WS_B, members: [USERS.bob] as string[] },
  ];
  const orgMembers = [
    { org: WS_A.org, userId: USERS.alice, role: "MEMBER" },
    { org: WS_B.org, userId: USERS.bob, role: "MEMBER" },
  ];

  const feedback: FeedbackRow[] = [
    { id: "fb-a", workspaceId: WS_A.id, title: "A feedback", status: "OPEN", type: "IDEA", opportunityId: null, updatedAt: null },
    { id: "fb-b", workspaceId: WS_B.id, title: "B feedback", status: "OPEN", type: "IDEA", opportunityId: null, updatedAt: null },
  ];
  const opportunities: OpportunityRow[] = [
    { id: "opp-a", workspaceId: WS_A.id, title: "A opportunity", status: "EXPLORING", squadId: "squad-a", linkedKeyResultId: null, sortOrder: 0, createdAt: new Date(1) },
    { id: "opp-b", workspaceId: WS_B.id, title: "B opportunity", status: "EXPLORING", squadId: "squad-b", linkedKeyResultId: null, sortOrder: 0, createdAt: new Date(1) },
  ];
  const squads: SquadRow[] = [
    { id: "squad-a", workspaceId: WS_A.id, name: "A squad", color: "#111111", createdAt: new Date(1) },
    { id: "squad-b", workspaceId: WS_B.id, name: "B squad", color: "#222222", createdAt: new Date(1) },
  ];

  // ── Solution / Objective graph (ADR Phase 0) ───────────────────────────────
  // Every Solution and Objective carries its own workspaceId. The "-null" rows
  // model a row that predates the backfill: workspaceId is NULL while its
  // parent chain still points at workspace A. Authorization must DENY them —
  // reading the parent chain here would (wrongly) allow Alice.
  const okrCycles: Graph[] = [
    { id: "cycle-a", workspaceId: WS_A.id, title: "A cycle", status: "ACTIVE" },
    { id: "cycle-b", workspaceId: WS_B.id, title: "B cycle", status: "ACTIVE" },
  ];
  const graphSolutions: Graph[] = [
    { id: "sol-a", workspaceId: WS_A.id, opportunityId: "opp-a", title: "A solution", status: "IDEA", sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1) },
    { id: "sol-b", workspaceId: WS_B.id, opportunityId: "opp-b", title: "B solution", status: "IDEA", sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1) },
    { id: "sol-null", workspaceId: null, opportunityId: "opp-a", title: "Unbackfilled solution", status: "IDEA", sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1) },
  ];
  const objectives: Graph[] = [
    { id: "obj-a", workspaceId: WS_A.id, cycleId: "cycle-a", title: "A objective", status: "ON_TRACK", sortOrder: 0 },
    { id: "obj-b", workspaceId: WS_B.id, cycleId: "cycle-b", title: "B objective", status: "ON_TRACK", sortOrder: 0 },
    { id: "obj-null", workspaceId: null, cycleId: "cycle-a", title: "Unbackfilled objective", status: "ON_TRACK", sortOrder: 0 },
  ];
  const keyResults: Graph[] = [
    { id: "kr-a", objectiveId: "obj-a", title: "A key result", target: 10, current: 0, sortOrder: 0 },
    { id: "kr-b", objectiveId: "obj-b", title: "B key result", target: 10, current: 0, sortOrder: 0 },
    { id: "kr-null", objectiveId: "obj-null", title: "Key result under an unbackfilled objective", target: 10, current: 0, sortOrder: 0 },
  ];
  const assumptions: Graph[] = [
    { id: "asm-a", solutionId: "sol-a", title: "A assumption" },
    { id: "asm-b", solutionId: "sol-b", title: "B assumption" },
    { id: "asm-null", solutionId: "sol-null", title: "Assumption under an unbackfilled solution" },
  ];
  const solutionComments: Graph[] = [
    { id: "scm-a", solutionId: "sol-a", body: "A comment" },
    { id: "scm-b", solutionId: "sol-b", body: "B comment" },
    { id: "scm-null", solutionId: "sol-null", body: "Comment under an unbackfilled solution" },
  ];
  const workspaceRows = workspaces as unknown as Graph[];
  const tables: Record<string, Graph[]> = {
    workspace: workspaceRows,
    opportunity: opportunities as unknown as Graph[],
    squad: squads as unknown as Graph[],
    okrCycle: okrCycles,
    solution: graphSolutions,
    objective: objectives,
    keyResult: keyResults,
    assumption: assumptions,
    solutionComment: solutionComments,
  };
  const relations: Record<string, Record<string, { model: string; fk: string }>> = {
    opportunity: { workspace: { model: "workspace", fk: "workspaceId" } },
    squad: { workspace: { model: "workspace", fk: "workspaceId" } },
    okrCycle: { workspace: { model: "workspace", fk: "workspaceId" } },
    solution: { workspace: { model: "workspace", fk: "workspaceId" }, opportunity: { model: "opportunity", fk: "opportunityId" } },
    objective: { workspace: { model: "workspace", fk: "workspaceId" }, cycle: { model: "okrCycle", fk: "cycleId" } },
    keyResult: { objective: { model: "objective", fk: "objectiveId" } },
    assumption: { solution: { model: "solution", fk: "solutionId" } },
    solutionComment: { solution: { model: "solution", fk: "solutionId" } },
  };
  const relatedRow = (model: string, row: Graph, relation: string): { model: string; row: Graph | null } | null => {
    const rel = relations[model]?.[relation];
    if (!rel) return null;
    const fk = row[rel.fk];
    return { model: rel.model, row: fk == null ? null : (tables[rel.model].find((r) => r.id === fk) ?? null) };
  };

  /** Prisma-style `where` evaluation over the graph; unsupported keys throw so a new query shape cannot silently pass. */
  const matches = (model: string, row: Graph, where: Where | undefined): boolean => {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (key === "AND") {
        const parts = Array.isArray(cond) ? cond : [cond];
        if (!parts.every((p) => matches(model, row, p as Where))) return false;
        continue;
      }
      if (key === "OR") {
        if (!(cond as Where[]).some((p) => matches(model, row, p))) return false;
        continue;
      }
      if (model === "workspace" && key === "organization") {
        if ((cond as { slug?: string }).slug !== undefined && (cond as { slug?: string }).slug !== row.org) return false;
        continue;
      }
      if (model === "workspace" && key === "members") {
        const userId = (cond as { some?: { userId?: string } }).some?.userId;
        if (!(row.members as string[]).includes(userId as string)) return false;
        continue;
      }
      const related = relatedRow(model, row, key);
      if (related) {
        if (!related.row || !matches(related.model, related.row, cond as Where)) return false;
        continue;
      }
      if (!(key in row)) throw new Error(`fake prisma: unsupported where key "${key}" on ${model}`);
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const op = cond as { in?: unknown[]; contains?: string; not?: unknown };
        if (op.in !== undefined) { if (!op.in.includes(value)) return false; continue; }
        if (op.contains !== undefined) {
          if (typeof value !== "string" || !value.toLowerCase().includes(op.contains.toLowerCase())) return false;
          continue;
        }
        if (op.not !== undefined) { if (value === op.not) return false; continue; }
        throw new Error(`fake prisma: unsupported operator on ${model}.${key}`);
      }
      if (value !== cond) return false;
    }
    return true;
  };

  const project = (model: string, row: Graph, args: { select?: Record<string, unknown>; include?: Record<string, unknown> } = {}): Graph => {
    if (args.select) {
      const out: Graph = {};
      for (const [key, sel] of Object.entries(args.select)) {
        if (sel === true) { out[key] = row[key]; continue; }
        const related = relatedRow(model, row, key);
        if (!related) continue;
        out[key] = related.row ? project(related.model, related.row, sel as { select?: Record<string, unknown> }) : null;
      }
      return out;
    }
    const out: Graph = { ...row };
    for (const [key, inc] of Object.entries(args.include ?? {})) {
      const related = relatedRow(model, row, key);
      // Unmodelled to-many relations (e.g. roadmapItems) come back empty.
      if (!related) { out[key] = []; continue; }
      out[key] = related.row ? project(related.model, related.row, inc === true ? {} : (inc as { select?: Record<string, unknown> })) : null;
    }
    return out;
  };

  let created = 0;
  const writes: string[] = [];
  const delegate = (model: string) => ({
    findFirst: async (args: { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown> } = {}) => {
      const row = tables[model].find((r) => matches(model, r, args.where));
      return row ? project(model, row, args) : null;
    },
    findUnique: async (args: { where: Where; select?: Record<string, unknown>; include?: Record<string, unknown> }) => {
      const row = tables[model].find((r) => matches(model, r, args.where));
      return row ? project(model, row, args) : null;
    },
    findMany: async (args: { where?: Where; select?: Record<string, unknown>; include?: Record<string, unknown>; take?: number } = {}) => {
      const rows = tables[model].filter((r) => matches(model, r, args.where)).map((r) => project(model, r, args));
      return args.take ? rows.slice(0, args.take) : rows;
    },
    count: async (args: { where?: Where } = {}) => tables[model].filter((r) => matches(model, r, args.where)).length,
    create: async ({ data, select }: { data: Graph; select?: Record<string, unknown> }) => {
      const row: Graph = { id: `${model}-new-${++created}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      tables[model].push(row);
      writes.push(`${model}.create:${row.id}`);
      return project(model, row, { select });
    },
    update: async ({ where, data }: { where: Where; data: Graph }) => {
      const row = tables[model].find((r) => matches(model, r, where));
      if (!row) throw new Error("Record to update not found.");
      Object.assign(row, data);
      writes.push(`${model}.update:${row.id}`);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Where; data: Graph }) => {
      const rows = tables[model].filter((r) => matches(model, r, where));
      for (const row of rows) { Object.assign(row, data); writes.push(`${model}.updateMany:${row.id}`); }
      return { count: rows.length };
    },
    delete: async ({ where }: { where: Where }) => {
      const index = tables[model].findIndex((r) => matches(model, r, where));
      if (index < 0) throw new Error("Record to delete does not exist.");
      const [row] = tables[model].splice(index, 1);
      writes.push(`${model}.delete:${row.id}`);
      return row;
    },
  });

  type Where = Record<string, unknown>;
  const eq = (row: Record<string, unknown>, where: Where | undefined, allowed: string[]) => {
    for (const [key, value] of Object.entries(where ?? {})) {
      if (!allowed.includes(key)) throw new Error(`fake prisma: unsupported where key "${key}"`);
      if (row[key] !== value) return false;
    }
    return true;
  };

  const docs = [
    { id: "doc-a", workspaceId: WS_A.id },
    { id: "doc-b", workspaceId: WS_B.id },
  ];
  const docVersions = [
    { id: "ver-a", docId: "doc-a", content: "A secret", title: "A doc" },
    { id: "ver-b", docId: "doc-b", content: "B secret", title: "B doc" },
  ];
  const docComments = [
    { id: "cmt-a", docId: "doc-a" },
    { id: "cmt-b", docId: "doc-b" },
  ];

  const client = {
    workspace: {
      findFirst: async ({ where }: { where: Where }) => {
        // Generic matcher so AND-composed membership filters (agentWorkspaceWhere) are honoured too.
        const found = workspaces.find((w) => matches("workspace", w as unknown as Graph, where));
        if (!found) return null;
        return {
          id: found.id,
          name: found.slug,
          slug: found.slug,
          organizationId: `org-${found.org}`,
          feedbackEnabled: true,
          roadmapPublic: false,
          portalAuthRequired: false,
          brandingPaletteId: null,
          brandingPrimaryHex: null,
          brandingFontPresetId: null,
          brandingFontFamily: null,
          brandingLogoUrl: null,
        };
      },
    },
    organizationMember: {
      findFirst: async ({ where }: { where: { organization?: { slug?: string }; userId?: string } }) => {
        const found = orgMembers.find(
          (m) => m.org === where.organization?.slug && m.userId === where.userId,
        );
        return found ? { role: found.role } : null;
      },
    },
    feedbackItem: {
      /** The unscoped shape the old actions used — kept so a regression is observable, not a TypeError. */
      update: async ({ where, data }: { where: { id: string }; data: Partial<FeedbackRow> }) => {
        const row = feedback.find((f) => f.id === where.id);
        if (!row) throw new Error("Record to update not found.");
        Object.assign(row, data);
        writes.push(`feedbackItem.update:${row.id}`);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<FeedbackRow> }) => {
        const rows = feedback.filter((f) => eq(f as unknown as Record<string, unknown>, where, ["id", "workspaceId"]));
        for (const row of rows) {
          Object.assign(row, data);
          writes.push(`feedbackItem.updateMany:${row.id}`);
        }
        return { count: rows.length };
      },
    },
    doc: {
      findUnique: async ({ where }: { where: { id: string } }) => docs.find((d) => d.id === where.id) ?? null,
    },
    docVersion: {
      findUnique: async ({ where }: { where: { id: string } }) => docVersions.find((v) => v.id === where.id) ?? null,
    },
    docComment: {
      findUnique: async ({ where }: { where: { id: string } }) => docComments.find((c) => c.id === where.id) ?? null,
    },
    solution: delegate("solution"),
    objective: delegate("objective"),
    keyResult: delegate("keyResult"),
    assumption: delegate("assumption"),
    solutionComment: delegate("solutionComment"),
    oKRCycle: delegate("okrCycle"),
    $transaction: async (work: (tx: unknown) => unknown) => work(client),
    opportunity: {
      ...delegate("opportunity"),
      findFirst: async ({ where }: { where: Where }) => {
        const row = opportunities.find((o) => matches("opportunity", o as unknown as Graph, where));
        return row ? { id: row.id, workspaceId: row.workspaceId } : null;
      },
      findMany: async ({ where }: { where: Where }) =>
        opportunities.filter((o) => matches("opportunity", o as unknown as Graph, where)),
    },
    squad: {
      ...delegate("squad"),
      findMany: async ({ where }: { where: Where }) =>
        squads.filter((s) => eq(s as unknown as Record<string, unknown>, where, ["workspaceId"])),
    },
  };

  return {
    client,
    /** Add a user to a workspace's members (for multi-workspace member scenarios). */
    addMember: (workspaceId: string, userId: string) => {
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (workspace && !workspace.members.includes(userId)) workspace.members.push(userId);
    },
    state: { feedback, opportunities, squads, writes, solutions: graphSolutions, objectives, keyResults, assumptions, solutionComments, okrCycles },
    /** Snapshot of every feedback row, for before/after "nothing changed" assertions. */
    snapshotFeedback: () => JSON.parse(JSON.stringify(feedback)) as unknown,
  };
}
