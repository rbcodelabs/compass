/**
 * Cross-tenant regression matrix for GET /api/panels/discovery-rail.
 *
 * The route is a plain GET, so the session alone must never be enough: the
 * caller has to be a member of the workspace the query-string slugs name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "./helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({
  auth: async () =>
    session.userId
      ? { user: { id: session.userId, name: "Test", email: "t@example.com", image: null } }
      : null,
}));

import { GET } from "@/app/api/panels/discovery-rail/route";

function get(org: string, ws: string) {
  return GET(new Request(`http://localhost/api/panels/discovery-rail?orgSlug=${org}&workspaceSlug=${ws}`));
}

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  session.userId = null;
});

describe("GET /api/panels/discovery-rail authorization", () => {
  it("returns the workspace's own opportunities and squads to a member (control)", async () => {
    session.userId = USERS.alice;
    const res = await get(WS_A.org, WS_A.slug);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.workspaceId).toBe(WS_A.id);
    expect(body.opportunities.map((o: { id: string }) => o.id)).toEqual(["opp-a"]);
    expect(body.squads.map((s: { id: string }) => s.id)).toEqual(["squad-a"]);
  });

  it("adds linkedObjectives from the typed links, never a link row that is wrong for the workspace, and nothing of B's", async () => {
    session.userId = USERS.alice;
    const links = fake.current!.state.opportunityObjectiveLinks;
    const row = (extra: Record<string, unknown>) => ({ id: `l${links.length}`, createdAt: new Date(links.length + 1), origin: "DIRECT", ...extra });
    links.push(row({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-a" }));
    // Stamped with A's workspaceId but pointing at B's objective, and at an objective with a NULL workspaceId: both hidden.
    links.push(row({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-b" }));
    links.push(row({ workspaceId: WS_A.id, opportunityId: "opp-a", objectiveId: "obj-null" }));
    // B's own link, stamped B: never in A's payload.
    links.push(row({ workspaceId: WS_B.id, opportunityId: "opp-b", objectiveId: "obj-b" }));
    const res = await get(WS_A.org, WS_A.slug);
    const body = await res.json();
    expect(body.opportunities).toEqual([expect.objectContaining({ id: "opp-a", linkedObjectives: [{ id: "obj-a", title: "A objective" }] })]);
    expect(JSON.stringify(body)).not.toContain("B objective");
  });

  it("401s with no session and reads nothing", async () => {
    const res = await get(WS_B.org, WS_B.slug);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain("B opportunity");
  });

  it("404s a signed-in non-member asking for workspace B, with no B data in the body", async () => {
    session.userId = USERS.eve;
    const res = await get(WS_B.org, WS_B.slug);
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(404);
    expect(text).not.toContain("B opportunity");
    expect(text).not.toContain("B squad");
    expect(text).not.toContain(WS_B.id);
  });

  it("404s a member of A asking for workspace B, with no B data in the body", async () => {
    session.userId = USERS.alice;
    const res = await get(WS_B.org, WS_B.slug);
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(404);
    expect(text).not.toContain("B opportunity");
    expect(text).not.toContain("B squad");
    expect(text).not.toContain(WS_B.id);
  });

  it("404s a mixed slug pair (A's org with B's workspace slug)", async () => {
    session.userId = USERS.alice;
    const res = await get(WS_A.org, WS_B.slug);
    expect(res.status).toBe(404);
  });

  it("answers a non-existent workspace and a non-member workspace identically", async () => {
    session.userId = USERS.eve;
    const missing = await get("nope", "nope");
    const foreign = await get(WS_B.org, WS_B.slug);
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("400s when a slug is missing", async () => {
    session.userId = USERS.alice;
    const res = await GET(new Request("http://localhost/api/panels/discovery-rail?orgSlug=acme"));
    expect(res.status).toBe(400);
  });
});
