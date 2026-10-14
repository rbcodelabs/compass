/**
 * A tiny in-memory stand-in for the slice of Prisma the roadmap creation and
 * sync helpers use. It implements exactly the query shapes those helpers issue,
 * so tests exercise the real helper logic (idempotence, suppression, slotting)
 * instead of asserting on mock call arguments.
 */
type Row = Record<string, unknown> & { id: string };

export type FakeState = {
  solutions: Row[];
  squads: Row[];
  items: Row[];
};

type Where = Record<string, unknown>;

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
      return false;
    }
    return (value ?? null) === (condition ?? null);
  });
}

export function createFakePrisma(state: FakeState) {
  let counter = 0;
  const tx = {
    solution: {
      findMany: async ({ where, take }: { where?: Where; take?: number }) => {
        // Relation filters the generic matcher cannot express: roadmapItems.none and score.is.
        const { roadmapItems, score, ...plain } = (where ?? {}) as Where & { roadmapItems?: { none?: Where }; score?: { is?: { normalizedScore?: { gte?: number } } } };
        const rows = state.solutions.filter((row) => {
          if (!matches(row, plain)) return false;
          if (roadmapItems?.none && state.items.some((item) => item.solutionId === row.id && matches(item, roadmapItems.none))) return false;
          const minimum = score?.is?.normalizedScore?.gte;
          if (minimum !== undefined && !(((row.score as { normalizedScore?: number } | undefined)?.normalizedScore ?? -1) >= minimum)) return false;
          return true;
        });
        return take ? rows.slice(0, take) : rows;
      },
    },
    squad: {
      findMany: async ({ where }: { where?: Where }) => state.squads.filter((row) => matches(row, where)),
    },
    roadmapItem: {
      findMany: async ({ where }: { where?: Where }) => state.items.filter((row) => matches(row, where)),
      findFirst: async ({ where }: { where?: Where }) => {
        const found = state.items.filter((row) => matches(row, where)).sort((a, b) => Number(b.sortOrder ?? 0) - Number(a.sortOrder ?? 0));
        return found[0] ?? null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.items.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = (data.id as string | undefined) ?? `item-${++counter}`;
        if (state.items.some((row) => row.id === id)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const now = new Date("2026-10-04T12:00:00.000Z");
        const row: Row = { status: "ACTIVE", autoCreated: null, scheduleEditedAt: null, description: null, startDate: null, endDate: null, isPrivate: false, sortOrder: 0, createdAt: now, updatedAt: now, ...data, id };
        state.items.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.items.find((item) => item.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
  };
  return tx as unknown as import("@/lib/db").AppPrismaClient;
}

export function solutionRow(id: string, overrides: Record<string, unknown> = {}): Row {
  return {
    id,
    workspaceId: "ws-1",
    title: `Solution ${id}`,
    status: "VALIDATED",
    opportunityId: `opp-${id}`,
    opportunity: { id: `opp-${id}`, squadId: "squad-a", linkedKeyResultId: "kr-1" },
    ...overrides,
  };
}
