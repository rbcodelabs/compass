import { beforeEach, describe, expect, it, vi } from "vitest"

const redirect = vi.hoisted(() => vi.fn())
const auth = vi.hoisted(() => vi.fn())
const workspace = { findFirst: vi.fn() }
const researchStudy = { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() }
const researchParticipantToken = { create: vi.fn(), updateMany: vi.fn() }
const transaction = vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations))
const runResearchInterviewAgent = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({ redirect }))
vi.mock("@/auth", () => ({ auth }))
vi.mock("@/lib/research-agent", () => ({ runResearchInterviewAgent }))
vi.mock("@/lib/db", () => ({
  default: () => ({
    workspace,
    researchStudy,
    researchParticipantToken,
    $transaction: transaction,
  }),
}))

import { createResearchStudy, generateUsabilityTasks, regenerateResearchLink, revokeResearchLinks } from "@/app/[orgSlug]/[workspaceSlug]/capture/actions"

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

  it("generates 5–8 realistic editable tasks through the tool-free Compass agent", async () => {
    runResearchInterviewAgent.mockResolvedValue(JSON.stringify([
      "Find the plan that fits a five-person team.",
      "Start creating an account for your team.",
      "Locate the cancellation policy.",
      "Find a way to contact support.",
      "Change the billing cadence to annual.",
    ]))

    await expect(generateUsabilityTasks("acme", "product", {
      goal: "Learn whether pricing makes sense",
      appUrl: "https://example.com/pricing",
      targetMinutes: 15,
    })).resolves.toEqual([
      "Find the plan that fits a five-person team.",
      "Start creating an account for your team.",
      "Locate the cancellation policy.",
      "Find a way to contact support.",
      "Change the billing cadence to annual.",
    ])
    expect(runResearchInterviewAgent).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Return only a JSON array of 5 to 8"),
    }))
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

  it("creates a guided usability study with a normalized app URL and selected duration", async () => {
    const data = form()
    data.set("studyType", "USABILITY_TEST")
    data.set("appUrl", "https://Example.com/product/#private")
    data.set("targetMinutes", "20")
    data.delete("guide")
    data.append("guide", "Find the right plan for your team.")

    await createResearchStudy("acme", "product", data)

    expect(researchStudy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        studyType: "USABILITY_TEST",
        appUrl: "https://example.com/product/",
        targetMinutes: 20,
        guide: JSON.stringify([{ id: "1", text: "Find the right plan for your team." }]),
      }),
    })
  })

  it("rejects browser-defined study types, unsafe URLs, and unsupported durations", async () => {
    for (const [field, value] of [
      ["studyType", "PROMPT_OVERRIDE"],
      ["appUrl", "https://127.0.0.1/admin"],
      ["targetMinutes", "999"],
    ] as const) {
      const data = form()
      data.set("studyType", "USABILITY_TEST")
      data.set("appUrl", "https://example.com")
      data.set("targetMinutes", "15")
      data.set(field, value)
      await expect(createResearchStudy("acme", "product", data)).rejects.toThrow()
    }
    expect(researchStudy.create).not.toHaveBeenCalled()
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
