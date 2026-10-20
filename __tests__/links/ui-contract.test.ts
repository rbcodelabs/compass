import { beforeEach, describe, expect, it, vi } from "vitest";
import { WS_A, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";
import { LINK_TYPES, toTypesOf } from "@/lib/links/registry";
import { SUMMARISED_ENTITY_TYPES } from "@/lib/links/read-models";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma>, user: "user-alice" as string | null }));
vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({ auth: async () => (fake.user ? { user: { id: fake.user } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace-updates-capture", () => ({
  withWorkspaceUpdates: async (prisma: unknown, callback: (tx: unknown, capture: boolean) => unknown) => callback(prisma, false),
}));

import { changeEntityLink, readEntityLinks } from "@/app/[orgSlug]/[workspaceSlug]/links/actions";

describe("every registry type with a UI is fully described", () => {
  // Legacy-mirrored types have no UI: reads stay on the legacy table until a later phase flips them.
  it.each(Object.values(LINK_TYPES).filter((def) => !def.legacy))("$key has candidates and summary loaders for its endpoints", (def) => {
    expect(typeof def.candidates).toBe("function");
    const specs = [def.summaries.onFrom ? toTypesOf(def)[0] : null, def.summaries.onTo ? def.from : null].filter(Boolean);
    for (const type of specs) expect(SUMMARISED_ENTITY_TYPES).toContain(type);
  });
});

const E = "00000000-0000-4000-8000-0000000000e1";
const S = "00000000-0000-4000-8000-0000000000a1";
const KEY = "EXPERIMENT_INFORMED_BY_STUDY";
const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  fake.user = "user-alice";
  const s = fake.current.state;
  s.experiments.push({ id: E, workspaceId: WS_A.id, title: "E1", status: "DESIGNING", updatedAt: new Date(1) });
  s.researchStudies.push({ id: S, workspaceId: WS_A.id, name: "S1", studyType: "CUSTOMER_INTERVIEW", status: "ACTIVE", updatedAt: new Date(1) });
  s.researchStudies.push({ id: uuid("a2"), workspaceId: WS_A.id, name: "PM", studyType: "PM_INTERVIEW", status: "ACTIVE", updatedAt: new Date(1) });
  s.researchStudies.push({ id: uuid("a3"), workspaceId: WS_A.id, name: "Old", studyType: "CUSTOMER_INTERVIEW", status: "ARCHIVED", updatedAt: new Date(1) });
});

const target = { linkType: KEY, entityType: "EXPERIMENT", entityId: E };

describe("UI actions", () => {
  it("links, is idempotent, and unlinks without touching the study or the experiment status", async () => {
    const study = () => fake.current!.state.researchStudies.find((r) => r.id === S)!;
    const before = { ...study() };
    expect(await changeEntityLink("acme", "alpha", { ...target, otherId: S, operation: "link" })).toEqual({ ok: true, changed: true });
    expect(await changeEntityLink("acme", "alpha", { ...target, otherId: S, operation: "link" })).toEqual({ ok: true, changed: false });
    expect(fake.current!.state.entityLinks).toHaveLength(1);
    expect(study()).toEqual(before);
    expect(fake.current!.state.experiments.find((r) => r.id === E)!.status).toBe("DESIGNING");
    const read = await readEntityLinks("acme", "alpha", target);
    expect(read.ok && read.view?.linked.map((i) => i.id)).toEqual([S]);
    expect(await changeEntityLink("acme", "alpha", { ...target, otherId: S, operation: "unlink" })).toEqual({ ok: true, changed: true });
    expect(await changeEntityLink("acme", "alpha", { ...target, otherId: S, operation: "unlink" })).toEqual({ ok: true, changed: false });
  });

  it("links from the study side with the same orientation", async () => {
    const res = await changeEntityLink("acme", "alpha", { linkType: KEY, entityType: "RESEARCH_STUDY", entityId: S, otherId: E, operation: "link" });
    expect(res).toEqual({ ok: true, changed: true });
    expect(fake.current!.state.entityLinks[0]).toMatchObject({ fromId: E, toId: S });
  });

  it("refuses PM interview and archived studies with a user-safe message", async () => {
    const pm = await changeEntityLink("acme", "alpha", { ...target, otherId: uuid("a2"), operation: "link" });
    expect(pm.ok).toBe(false);
    const archived = await changeEntityLink("acme", "alpha", { ...target, otherId: uuid("a3"), operation: "link" });
    expect(archived).toMatchObject({ ok: false, error: expect.stringMatching(/Archived/) });
    expect(fake.current!.state.entityLinks).toHaveLength(0);
  });

  it("denies non-members, signed-out callers and a wrong entity type without writing", async () => {
    fake.user = "user-eve";
    expect((await changeEntityLink("acme", "alpha", { ...target, otherId: S, operation: "link" })).ok).toBe(false);
    expect((await readEntityLinks("acme", "alpha", target)).ok).toBe(false);
    fake.user = null;
    expect((await changeEntityLink("acme", "alpha", { ...target, otherId: S, operation: "link" })).ok).toBe(false);
    fake.user = "user-alice";
    expect((await changeEntityLink("acme", "alpha", { ...target, entityType: "TASK", otherId: S, operation: "link" })).ok).toBe(false);
    expect(fake.current!.state.entityLinks).toHaveLength(0);
  });
});
