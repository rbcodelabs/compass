import { beforeEach, describe, expect, it, vi } from "vitest"

const session = vi.hoisted(() => ({ user: null as null | { id: string; name?: string | null; email?: string | null } }))
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  revalidate: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: async () => (session.user ? { user: session.user } : null) }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/doc-comment-tasks", () => ({ postDocCommentWithOptionalTask: mocks.post }))
vi.mock("@/lib/document-service", () => ({}))
vi.mock("@/lib/doc-comments", () => ({}))
vi.mock("@/lib/positioning-brief", () => ({}))
vi.mock("@/lib/task-assignment", () => ({}))
vi.mock("@/lib/linked-tasks", () => ({}))
vi.mock("@/lib/artifacts", () => ({}))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: vi.fn() }))

import { addDocCommentWithTask } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

const input = { docId: "doc-1", body: "hello", task: { title: "T" } }

beforeEach(() => {
  vi.resetAllMocks()
  session.user = { id: "user-1", name: "Rick", email: "rick@example.com" }
})

describe("addDocCommentWithTask", () => {
  it("rejects an unauthenticated caller before reaching the service", async () => {
    session.user = null
    await expect(addDocCommentWithTask(input, "/p")).rejects.toThrow("Unauthorized")
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it("attributes the comment to the signed-in user, never to a caller-supplied identity", async () => {
    mocks.post.mockResolvedValue({ ok: true })
    // Extra fields a hostile client might add must not be able to override the author.
    await addDocCommentWithTask({ ...input, userId: "someone-else", userName: "Mallory" } as typeof input, "/p")
    expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", userName: "Rick" }))
  })

  it("returns service rejections as values and only revalidates on success", async () => {
    mocks.post.mockResolvedValueOnce({ ok: false, error: "FORBIDDEN" })
    expect(await addDocCommentWithTask(input, "/p")).toEqual({ ok: false, error: "FORBIDDEN" })
    expect(mocks.revalidate).not.toHaveBeenCalled()

    mocks.post.mockResolvedValueOnce({ ok: true })
    await addDocCommentWithTask(input, "/p")
    expect(mocks.revalidate).toHaveBeenCalledWith("/p")
  })
})
