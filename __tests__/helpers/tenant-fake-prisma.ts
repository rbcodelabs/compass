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

  const writes: string[] = [];

  const client = {
    workspace: {
      findFirst: async ({ where }: { where: Where }) => {
        const org = (where.organization as { slug?: string } | undefined)?.slug;
        const memberId = (where.members as { some?: { userId?: string } } | undefined)?.some?.userId;
        const found = workspaces.find(
          (w) =>
            (where.id === undefined || w.id === where.id) &&
            (where.slug === undefined || w.slug === where.slug) &&
            (org === undefined || w.org === org) &&
            (memberId === undefined || w.members.includes(memberId)),
        );
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
    opportunity: {
      findFirst: async ({ where }: { where: Where }) => {
        const row = opportunities.find((o) => eq(o as unknown as Record<string, unknown>, where, ["id", "workspaceId"]));
        return row ? { id: row.id, workspaceId: row.workspaceId } : null;
      },
      findMany: async ({ where }: { where: Where }) =>
        opportunities.filter((o) => eq(o as unknown as Record<string, unknown>, where, ["workspaceId"])),
    },
    squad: {
      findMany: async ({ where }: { where: Where }) =>
        squads.filter((s) => eq(s as unknown as Record<string, unknown>, where, ["workspaceId"])),
    },
  };

  return {
    client,
    state: { feedback, opportunities, squads, writes },
    /** Snapshot of every feedback row, for before/after "nothing changed" assertions. */
    snapshotFeedback: () => JSON.parse(JSON.stringify(feedback)) as unknown,
  };
}
