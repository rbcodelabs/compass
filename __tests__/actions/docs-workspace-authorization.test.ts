/**
 * Cross-tenant regression matrix for the Docs server actions.
 *
 * The core helpers (document-service, doc-comments) are auth-neutral by design,
 * so the actions are the only place tenancy is enforced. They are replaced with
 * spies here: the assertion is that a caller who fails the workspace check
 * never reaches them, and that the legitimate path still does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USERS, WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma";

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }));
const session = vi.hoisted(() => ({ userId: null as string | null }));
const core = vi.hoisted(() => ({
  createDocument: vi.fn(async () => ({ id: "new-doc", title: "Untitled", revision: "r1" })),
  updateDocument: vi.fn(async () => ({ id: "doc", revision: "r2" })),
  snapshotDocument: vi.fn(async () => ({})),
  restoreDocument: vi.fn(async () => ({ id: "doc", revision: "r3" })),
  deleteDocument: vi.fn(async () => ({})),
  hydrateDocument: vi.fn(async () => ({ hydrated: true })),
  createDocCommentCore: vi.fn(async () => ({ ok: true, comment: { id: "c" } })),
  listDocCommentsCore: vi.fn(async () => []),
  setDocCommentStatusCore: vi.fn(async () => ({ id: "c" })),
  deleteDocCommentCore: vi.fn(async () => ({ id: "c" })),
  createPositioningBriefCore: vi.fn(async () => ({ ok: true, docId: "brief" })),
  validateTaskLink: vi.fn(async () => undefined),
  fetchLinkedTasksBundle: vi.fn(async () => ({ tasks: [] })),
}));

vi.mock("@/lib/db", () => ({ default: () => fake.current!.client }));
vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId, name: "T", email: "t@example.com" } } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }) }));
vi.mock("@/lib/document-service", () => ({
  createDocument: core.createDocument,
  updateDocument: core.updateDocument,
  snapshotDocument: core.snapshotDocument,
  restoreDocument: core.restoreDocument,
  deleteDocument: core.deleteDocument,
  hydrateDocument: core.hydrateDocument,
}));
vi.mock("@/lib/doc-comments", () => ({
  createDocCommentCore: core.createDocCommentCore,
  listDocCommentsCore: core.listDocCommentsCore,
  setDocCommentStatusCore: core.setDocCommentStatusCore,
  deleteDocCommentCore: core.deleteDocCommentCore,
}));
vi.mock("@/lib/positioning-brief", () => ({ createPositioningBriefCore: core.createPositioningBriefCore }));
vi.mock("@/lib/task-assignment", () => ({ validateTaskLink: core.validateTaskLink }));
vi.mock("@/lib/linked-tasks", () => ({ fetchLinkedTasksBundle: core.fetchLinkedTasksBundle }));
vi.mock("@/lib/artifacts", () => ({}));
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: vi.fn() }));

import * as actions from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

const P = "/p";

/** Every action that takes a doc/version/comment/workspace ID, driven against a chosen "target" tenant. */
type Target = { ws: string; doc: string; ver: string; cmt: string };
const A: Target = { ws: WS_A.id, doc: "doc-a", ver: "ver-a", cmt: "cmt-a" };
const B: Target = { ws: WS_B.id, doc: "doc-b", ver: "ver-b", cmt: "cmt-b" };

const cases: Array<[string, (t: Target, wsForCall?: string) => Promise<unknown>]> = [
  ["createDoc", (t) => actions.createDoc(t.ws, null, P)],
  ["updateDoc", (t) => actions.updateDoc(t.doc, { title: "x" }, P)],
  ["updateDocMetadata", (t) => actions.updateDocMetadata(t.doc, { a: 1 }, P)],
  ["createDocVersion", (t) => actions.createDocVersion(t.doc, "snap", P)],
  ["getDocVersionContent", (t) => actions.getDocVersionContent(t.ver)],
  ["restoreDocVersion", (t) => actions.restoreDocVersion(t.ver, P)],
  ["deleteDoc (id only)", (t) => actions.deleteDoc(t.doc, P)],
  ["addDocComment", (t) => actions.addDocComment({ docId: t.doc, body: "hi" }, P)],
  ["listDocComments", (t) => actions.listDocComments(t.doc)],
  ["resolveDocComment", (t) => actions.resolveDocComment(t.cmt, true, P)],
  ["deleteDocComment", (t) => actions.deleteDocComment(t.cmt, P)],
  ["getDocLinkedTasks", (t) => actions.getDocLinkedTasks(t.ws, t.doc)],
  ["createPositioningBrief", (t) => actions.createPositioningBrief("rm-1", t.ws, P)],
];

const coreSpies = () => Object.values(core).filter((fn) => fn !== core.validateTaskLink);
const noCoreCalls = () => coreSpies().every((fn) => fn.mock.calls.length === 0);

beforeEach(() => {
  fake.current = createTenantFakePrisma();
  session.userId = null;
  for (const fn of Object.values(core)) fn.mockClear();
});

describe.each(cases)("%s", (_name, call) => {
  it("works for a member acting inside their own workspace (control)", async () => {
    session.userId = USERS.alice;
    await expect(call(A)).resolves.not.toThrow();
    expect(noCoreCalls()).toBe(false);
  });

  it("rejects an unauthenticated caller before any core call", async () => {
    await expect(call(B)).rejects.toThrow();
    expect(noCoreCalls()).toBe(true);
  });

  it("rejects a signed-in non-member targeting workspace B", async () => {
    session.userId = USERS.eve;
    await expect(call(B)).rejects.toThrow();
    expect(noCoreCalls()).toBe(true);
  });

  it("rejects a member of A targeting workspace B's IDs", async () => {
    session.userId = USERS.alice;
    await expect(call(B)).rejects.toThrow();
    expect(noCoreCalls()).toBe(true);
  });
});

describe("workspace-scoped variants with a mismatched entity", () => {
  it("deleteDoc rejects a member of A who passes A's workspaceId with B's doc ID", async () => {
    session.userId = USERS.alice;
    await expect(actions.deleteDoc("doc-b", P, { workspaceId: WS_A.id })).rejects.toThrow("Document not found");
    expect(core.deleteDocument).not.toHaveBeenCalled();
  });

  it("deleteDoc rejects a member of A who passes B's workspaceId", async () => {
    session.userId = USERS.alice;
    await expect(actions.deleteDoc("doc-b", P, { workspaceId: WS_B.id })).rejects.toThrow();
    expect(core.deleteDocument).not.toHaveBeenCalled();
  });

  it("getDocLinkedTasks never reads a bundle for a workspace the caller is not in", async () => {
    session.userId = USERS.alice;
    await expect(actions.getDocLinkedTasks(WS_B.id, "doc-b")).rejects.toThrow();
    expect(core.fetchLinkedTasksBundle).not.toHaveBeenCalled();
  });

  it("createFirstDoc refuses slugs for a workspace the caller is not a member of", async () => {
    session.userId = USERS.eve;
    await expect(actions.createFirstDoc(WS_B.org, WS_B.slug)).rejects.toThrow("Workspace access denied");
    expect(core.createDocument).not.toHaveBeenCalled();
  });
});
