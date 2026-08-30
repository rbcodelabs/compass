import { beforeEach, describe, expect, it, vi } from "vitest"

const redirect = vi.hoisted(() => vi.fn())
const auth = vi.hoisted(() => vi.fn())
const workspace = { findFirst: vi.fn() }
const researchStudy = { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() }
const researchParticipantToken = { create: vi.fn(), updateMany: vi.fn() }
const transaction = vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations))

vi.mock("next/navigation", () => ({ redirect }))
vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    workspace,
    researchStudy,
    researchParticipantToken,
    $transaction: transaction,
  }),
}))

import { createResearchStudy, regenerateResearchLink, revokeResearchLinks } from "@/app/[orgSlug]/[workspaceSlug]/capture/actions"

function form() {
  const data = new FormData()
  data.set("name", "Planning interviews")
  data.set("goal", "Understand planning")
  data.append("guide", "Tell me about the last time.")
  return data
}

describe("research study actions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.mockResolvedValue({ user: { id: "user-1" } })
    workspace.findFirst.mockResolvedValue({ id: "workspace-1" })
    researchStudy.create.mockResolvedValue({ id: "study-1" })
    researchStudy.update.mockResolvedValue({ id: "study-1" })
    researchParticipantToken.create.mockResolvedValue({ id: "token-1" })
    researchParticipantToken.updateMany.mockResolvedValue({ count: 1 })
  })

  it("creates a study and first-class hashed PRIMARY token without persisting plaintext", async () => {
    await createResearchStudy("acme", "product", form())

    const studyData = researchStudy.create.mock.calls[0][0].data
    expect(studyData).not.toHaveProperty("shareTokenHash")
    const tokenData = researchParticipantToken.create.mock.calls[0][0].data
    expect(tokenData).toMatchObject({
      studyId: studyData.id,
      kind: "PRIMARY",
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: expect.any(Date),
    })
    const rawToken = new URLSearchParams(redirect.mock.calls[0][0].split("?")[1]).get("token")
    expect(rawToken).toBeTruthy()
    expect(JSON.stringify({ studyData, tokenData })).not.toContain(rawToken!)
  })

  it("denies a user who is not a member of the target workspace", async () => {
    workspace.findFirst.mockResolvedValue(null)
    await expect(createResearchStudy("acme", "private", form())).rejects.toThrow("Workspace not found")
    expect(researchStudy.create).not.toHaveBeenCalled()
  })

  it("rejects an overlong study name before writing", async () => {
    const data = form()
    data.set("name", "x".repeat(256))
    await expect(createResearchStudy("acme", "product", data)).rejects.toThrow("255")
    expect(researchStudy.create).not.toHaveBeenCalled()
  })

  it("rotates a link by revoking prior PRIMARY tokens and creating one new hashed token", async () => {
    researchStudy.findFirst.mockResolvedValue({ id: "study-1", status: "ACTIVE" })

    await regenerateResearchLink("acme", "product", "study-1")

    expect(researchParticipantToken.updateMany).toHaveBeenCalledWith({
      where: { studyId: "study-1", kind: "PRIMARY", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    expect(researchParticipantToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ studyId: "study-1", kind: "PRIMARY" }),
    })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(researchStudy.update).toHaveBeenCalledWith({
      where: { id: "study-1" },
      data: { updatedAt: expect.any(Date), updatedById: "user-1" },
    })
  })

  it("does not reactivate or rotate a closed study", async () => {
    researchStudy.findFirst.mockResolvedValue({ id: "study-1", status: "CLOSED" })

    await expect(regenerateResearchLink("acme", "product", "study-1")).rejects.toThrow("active")
    expect(researchParticipantToken.create).not.toHaveBeenCalled()
  })

  it("explicitly revokes active PRIMARY links without creating a replacement", async () => {
    researchStudy.findFirst.mockResolvedValue({ id: "study-1", status: "ACTIVE" })

    await revokeResearchLinks("acme", "product", "study-1")

    expect(researchParticipantToken.updateMany).toHaveBeenCalledWith({
      where: { studyId: "study-1", kind: "PRIMARY", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    expect(researchParticipantToken.create).not.toHaveBeenCalled()
    expect(researchStudy.update).toHaveBeenCalledWith({
      where: { id: "study-1" },
      data: { updatedAt: expect.any(Date), updatedById: "user-1" },
    })
  })
})
