import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { followableConfig } from "@/lib/followable"
import { withFollowingCommit } from "@/lib/following-commit"

const mocks = vi.hoisted(() => ({ available: vi.fn(), apply: vi.fn() }))
vi.mock("@/lib/workspace-updates-capture", () => ({ withWorkspaceUpdates: (db: unknown, fn: (db: unknown, enabled: boolean) => unknown) => fn(db, false), recordWorkspaceUpdate: vi.fn() }))
vi.mock("@/lib/workspace-update-mutations", () => ({ workspaceMutationActor: async () => ({ actorType: "USER", actorId: "user-1" }) }))
vi.mock("@/lib/following-flag", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/following-flag")>()), followingAvailable: mocks.available }))
vi.mock("@/lib/following-hooks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/following-hooks")>()), applyFollowingEffects: mocks.apply }))

const prisma = {
  comment: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  docCommentAnchor: { create: vi.fn() },
  solutionPlanProposal: { create: vi.fn() },
  commentElementAnchor: { create: vi.fn() },
  commentExternalAuthor: { create: vi.fn() },
  task: { findUnique: vi.fn() },
  experiment: { findUnique: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { createComment } from "@/lib/comments"
import { runWithMcpActor } from "@/lib/mcp-authz"

const WS = "11111111-1111-1111-1111-111111111111"
const TARGET = "22222222-2222-2222-2222-222222222222"
const ROOT = "33333333-3333-3333-3333-333333333333"
const ME = "44444444-4444-4444-4444-444444444444"
const AGENT = "55555555-5555-5555-5555-555555555555"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("FOLLOWING_ENABLED", "1")
  followableConfig.shippedSlice = 2
  mocks.available.mockResolvedValue(true)
  mocks.apply.mockResolvedValue(undefined)
  prisma.task.findUnique.mockResolvedValue({ workspaceId: WS })
  prisma.experiment.findUnique.mockResolvedValue({ workspaceId: WS })
  prisma.comment.create.mockResolvedValue({ id: "c1" })
  prisma.comment.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === ROOT ? { id: ROOT, workspaceId: WS, targetType: "TASK", targetId: TARGET, parentId: null } : { id: where.id, body: "x", authorId: null, authorName: "n", authorType: "HUMAN", createdAt: new Date(), updatedAt: new Date() })
})
afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.unstubAllEnvs()
})

const comment = { workspaceId: WS, targetType: "TASK" as const, targetId: TARGET, body: "hello", authorName: "Rick", authorId: ME, authorType: "HUMAN" as const, source: "UI" as const }
const planned = () => mocks.apply.mock.calls[0]?.[0] as Array<{ type: string; source?: string; event?: Record<string, unknown> }>

describe("createComment following hook", () => {
  it("follows the commenter and notifies followers of a root comment, after the write", async () => {
    await createComment(comment)
    expect(prisma.comment.create).toHaveBeenCalledTimes(1)
    expect(planned()).toEqual([
      { type: "follow", target: { userId: ME, workspaceId: WS, subjectType: "TASK", subjectId: TARGET }, source: "AUTO_COMMENT" },
      { type: "emit", event: expect.objectContaining({ kind: "COMMENT_ADDED", dedupeKey: "comment:c1", actor: { type: "USER", id: ME }, payload: { commentId: "c1", parentCommentId: null } }) },
    ])
  })

  it("covers replies (COMMENT_REPLIED), which the Updates feed skips", async () => {
    await createComment({ ...comment, parentId: ROOT })
    expect(planned()[1].event).toMatchObject({ kind: "COMMENT_REPLIED", payload: { commentId: "c1", parentCommentId: ROOT } })
  })

  it("attributes an MCP comment to the credential, not to the AGENT author type", async () => {
    await runWithMcpActor({ purpose: "AGENT", userId: ME, agentId: AGENT }, () => createComment({ ...comment, authorId: undefined, authorType: "AGENT", source: "MCP" }))
    expect(planned().map((e) => e.type)).toEqual(["emit"])
    expect(planned()[0].event).toMatchObject({ actor: { type: "AGENT", id: AGENT } })
  })

  it("never lets an external author's identity into the event", async () => {
    await createComment({ ...comment, authorId: undefined, source: "WIDGET", externalAuthor: { submitterEmail: "visitor@example.com" } })
    expect(planned()[0].event).toMatchObject({ actor: { type: "EXTERNAL", id: null } })
    expect(JSON.stringify(mocks.apply.mock.calls)).not.toContain("example.com")
  })

  it("is silent for migration imports, unshipped subject types, FOLLOWING off and missing tables", async () => {
    await createComment({ ...comment, source: "MIGRATION" })
    await createComment({ ...comment, targetType: "EXPERIMENT" })
    mocks.available.mockResolvedValue(false)
    await createComment(comment)
    vi.stubEnv("FOLLOWING_ENABLED", "0")
    mocks.available.mockResolvedValue(true)
    await createComment(comment)
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("does not run effects when the comment write fails", async () => {
    prisma.comment.create.mockRejectedValue(new Error("write failed"))
    await expect(createComment(comment)).rejects.toThrow("write failed")
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("holds effects until the surrounding transaction commits", async () => {
    await withFollowingCommit(async () => {
      await createComment(comment)
      expect(mocks.apply).not.toHaveBeenCalled()
    })
    expect(mocks.apply).toHaveBeenCalledTimes(1)
  })

  it("does not fail the comment when the availability probe throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.available.mockRejectedValue(new Error("probe down"))
    await expect(createComment(comment)).resolves.toBeTruthy()
    expect(mocks.apply).not.toHaveBeenCalled()
  })
})
