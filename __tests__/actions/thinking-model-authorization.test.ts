/**
 * Tenant isolation and authorization for the updateThinkingModel server action.
 *
 * Uses the shared two-tenant fake. resolveWorkspaceAdmin semantics: the caller
 * must be a MEMBER of the workspace (the lookup filters on membership), and then
 * either a workspace ADMIN or an org OWNER/ADMIN. A read-only org member who has
 * no WorkspaceMember row never matches the workspace at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));
const revalidate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: "T", email: "t@example.com" } } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));

import { updateThinkingModel } from "@/app/[orgSlug]/[workspaceSlug]/settings/thinking-model-actions";

const wsA = () => fake.current!.state.workspaces.find((w) => w.id === WS_A.id)!;
const wsB = () => fake.current!.state.workspaces.find((w) => w.id === WS_B.id)!;
const torres = { thinkingModel: "TORRES_OST", labels: { keyResult: { singular: "Bet" } } };

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  session.userId = null;
  revalidate.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {}).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {}).mockClear();
});

describe("updateThinkingModel authorization", () => {
  it("lets a workspace admin write their own workspace", async () => {
    session.userId = USERS.carol;
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, torres);
    expect(r).toEqual({ ok: true, thinkingModel: "TORRES_OST" });
    expect(wsA().thinkingModel).toBe("TORRES_OST");
    expect(JSON.parse(wsA().thinkingModelLabels!)).toEqual({ keyResult: { singular: "Bet" } });
    expect(revalidate).toHaveBeenCalledWith(`/${WS_A.org}/${WS_A.slug}`, "layout");
  });

  it("lets an org admin who is a workspace member write", async () => {
    session.userId = USERS.dave;
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, torres);
    expect(r.ok).toBe(true);
    expect(wsA().thinkingModel).toBe("TORRES_OST");
  });

  it("rejects a plain workspace member", async () => {
    session.userId = USERS.alice;
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, torres);
    expect(r).toEqual({ ok: false, error: "Forbidden: workspace admin required" });
    expect(wsA().thinkingModel).toBeNull();
  });

  it("rejects a read-only org member who has no workspace membership", async () => {
    session.userId = USERS.frank;
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, torres);
    expect(r.ok).toBe(false);
    expect(wsA().thinkingModel).toBeNull();
  });

  it("rejects a signed-in non-member and an anonymous caller", async () => {
    session.userId = USERS.eve;
    expect((await updateThinkingModel(WS_A.org, WS_A.slug, torres)).ok).toBe(false);
    session.userId = null;
    expect((await updateThinkingModel(WS_A.org, WS_A.slug, torres)).ok).toBe(false);
    expect(wsA().thinkingModel).toBeNull();
  });

  it("an admin of A cannot write B, by slug or by smuggled id", async () => {
    session.userId = USERS.carol;
    expect((await updateThinkingModel(WS_B.org, WS_B.slug, torres)).ok).toBe(false);
    // Mixed: A's org with B's workspace slug resolves to nothing.
    expect((await updateThinkingModel(WS_A.org, WS_B.slug, torres)).ok).toBe(false);
    // A client-supplied workspace id is rejected by the strict schema, never trusted.
    const smuggled = await updateThinkingModel(WS_A.org, WS_A.slug, { ...torres, workspaceId: WS_B.id });
    expect(smuggled.ok).toBe(false);
    expect(wsB().thinkingModel).toBeNull();
    expect(wsA().thinkingModel).toBeNull();
    expect(fake.current!.state.writes).toEqual([]);
  });

  it("writes only the derived workspace when an admin of A succeeds", async () => {
    session.userId = USERS.carol;
    await updateThinkingModel(WS_A.org, WS_A.slug, torres);
    expect(fake.current!.state.writes).toEqual([`workspace.update:${WS_A.id}`]);
    expect(wsB().thinkingModel).toBeNull();
  });
});

describe("updateThinkingModel input handling", () => {
  beforeEach(() => {
    session.userId = USERS.carol;
  });

  it("rejects an unknown preset key", async () => {
    expect((await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: "MINE" })).ok).toBe(false);
    expect(wsA().thinkingModel).toBeNull();
  });

  it("rejects renaming an entity other than Objective and Key Result, with a clear message", async () => {
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, {
      thinkingModel: "CLASSIC",
      labels: { solution: { singular: "Bet" } },
    });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("is not available yet") });
    expect(wsA().thinkingModel).toBeNull();
  });

  it("does not newly accept the preset that is defined but not offered", async () => {
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: "OPPORTUNITY_FIRST_OKR" });
    expect(r).toEqual({ ok: false, error: "That thinking model is not available yet." });
    expect(wsA().thinkingModel).toBeNull();
  });

  it("lets a workspace already on the hidden preset keep saving", async () => {
    wsA().thinkingModel = "OPPORTUNITY_FIRST_OKR";
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: "OPPORTUNITY_FIRST_OKR", labels: { objective: { singular: "Goal" } } });
    expect(r.ok).toBe(true);
  });

  it("logs only the error name and code when a write fails, never label text", async () => {
    const original = fake.current!.client.workspace.update;
    fake.current!.client.workspace.update = async () => {
      throw Object.assign(new Error('Invalid value for thinking_model_labels: {"objective":{"singular":"SECRET-LABEL"}}'), { code: "P2022" });
    };
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: "CLASSIC", labels: { objective: { singular: "SECRET-LABEL" } } });
    fake.current!.client.workspace.update = original;
    expect(r).toEqual({ ok: false, error: "Something went wrong. Please try again." });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("P2022");
    expect(logged).not.toContain("SECRET-LABEL");
  });

  it("rejects NULL / missing key (the UI never writes NULL)", async () => {
    expect((await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: null })).ok).toBe(false);
    expect((await updateThinkingModel(WS_A.org, WS_A.slug, {})).ok).toBe(false);
  });

  it("rejects invalid labels and writes nothing", async () => {
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, {
      thinkingModel: "CLASSIC",
      labels: { objective: { singular: "<script>" } },
    });
    expect(r.ok).toBe(false);
    expect(wsA().thinkingModel).toBeNull();
  });

  it("writes an explicit CLASSIC key (never NULL) and clears labels when none are given", async () => {
    wsA().thinkingModelLabels = JSON.stringify({ keyResult: { singular: "Bet" } });
    const r = await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: "CLASSIC" });
    expect(r.ok).toBe(true);
    expect(wsA().thinkingModel).toBe("CLASSIC");
    expect(wsA().thinkingModelLabels).toBeNull();
  });

  it("logs one structured line with ids and keys but no label text", async () => {
    wsA().thinkingModel = "CLASSIC";
    await updateThinkingModel(WS_A.org, WS_A.slug, { thinkingModel: "TORRES_OST", labels: { keyResult: { singular: "Bet" } } });
    const info = vi.mocked(console.info).mock.calls;
    expect(info).toHaveLength(1);
    const line = String(info[0][0]);
    expect(JSON.parse(line)).toEqual({
      event: "workspace.thinking_model.updated",
      workspaceId: WS_A.id,
      previousKey: "CLASSIC",
      newKey: "TORRES_OST",
    });
    expect(line).not.toContain("Bet");
  });
});
