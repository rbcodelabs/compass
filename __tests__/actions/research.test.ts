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

import {
  activateResearchStudy,
  archiveResearchStudy,
  closeResearchStudy,
  createResearchStudy,
  generateResearchGuide,
  regenerateResearchLink,
  revokeResearchLinks,
  updateResearchStudy,
} from "@/app/[orgSlug]/[workspaceSlug]/capture/actions"

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

  it("generates 5–8 realistic editable usability tasks through the tool-free Compass agent", async () => {
    runResearchInterviewAgent.mockResolvedValue(JSON.stringify([
      "Find the plan that fits a five-person team.",
      "Start creating an account for your team.",
      "Locate the cancellation policy.",
      "Find a way to contact support.",
      "Change the billing cadence to annual.",
    ]))

    await expect(generateResearchGuide("acme", "product", {
      studyType: "USABILITY_TEST",
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

  it("generates neutral editable customer-interview questions without requiring a product URL", async () => {
    runResearchInterviewAgent.mockResolvedValue(JSON.stringify([
      "Tell me about the last time you planned this work.",
      "What prompted you to start?",
      "What did you try first?",
      "Where did the process become difficult?",
      "What did you do next?",
    ]))

    await expect(generateResearchGuide("acme", "product", {
      studyType: "CUSTOMER_INTERVIEW",
      goal: "Understand existing planning behavior",
      appUrl: "",
      targetMinutes: 20,
    })).resolves.toHaveLength(5)
    expect(runResearchInterviewAgent).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("customer discovery interview"),
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

  it("persists the selected duration for a customer interview", async () => {
    const data = form()
    data.set("targetMinutes", "30")

    await createResearchStudy("acme", "product", data)

    expect(researchStudy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetMinutes: 30 }),
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

  it("updates the full protocol before the first session", async () => {
    researchStudy.findFirst.mockResolvedValue({
      id: "study-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW", goal: "Old goal",
      guide: JSON.stringify([{ id: "1", text: "Old question" }]), targetMinutes: 15, appUrl: null,
      _count: { sessions: 0 },
    })
    const data = form()
    data.set("name", "Updated interview")
    data.set("goal", "Updated goal")
    data.set("targetMinutes", "20")
    data.delete("guide")
    data.append("guide", "Updated question")

    await updateResearchStudy("acme", "product", "study-1", data)

    expect(researchStudy.update).toHaveBeenCalledWith({
      where: { id: "study-1" },
      data: expect.objectContaining({
        name: "Updated interview", goal: "Updated goal", targetMinutes: 20,
        guide: JSON.stringify([{ id: "1", text: "Updated question" }]),
      }),
    })
  })

  it("locks protocol fields after the first session while allowing the name to change", async () => {
    researchStudy.findFirst.mockResolvedValue({
      id: "study-1", status: "ACTIVE", studyType: "CUSTOMER_INTERVIEW", goal: "Locked goal",
      guide: JSON.stringify([{ id: "1", text: "Locked question" }]), targetMinutes: 15, appUrl: null,
      _count: { sessions: 1 },
    })
    const data = form()
    data.set("name", "New display name")
    data.set("goal", "Tampered goal")
    data.set("targetMinutes", "30")

    await updateResearchStudy("acme", "product", "study-1", data)

    expect(researchStudy.update).toHaveBeenCalledWith({
      where: { id: "study-1" },
      data: expect.objectContaining({ name: "New display name", goal: "Locked goal", targetMinutes: 15 }),
    })
  })

  it("closes and archives studies by revoking active participant links", async () => {
    researchStudy.findFirst.mockResolvedValue({ id: "study-1", status: "ACTIVE" })

    await closeResearchStudy("acme", "product", "study-1")
    expect(researchStudy.update).toHaveBeenLastCalledWith({
      where: { id: "study-1" },
      data: expect.objectContaining({ status: "CLOSED" }),
    })
    await archiveResearchStudy("acme", "product", "study-1")
    expect(researchStudy.update).toHaveBeenLastCalledWith({
      where: { id: "study-1" },
      data: expect.objectContaining({ status: "ARCHIVED" }),
    })
    expect(researchParticipantToken.updateMany).toHaveBeenCalledTimes(2)
  })

  it("reactivates a closed study with a fresh hashed participant link", async () => {
    researchStudy.findFirst.mockResolvedValue({ id: "study-1", status: "CLOSED" })

    await activateResearchStudy("acme", "product", "study-1")

    expect(researchStudy.update).toHaveBeenCalledWith({
      where: { id: "study-1" },
      data: expect.objectContaining({ status: "ACTIVE" }),
    })
    expect(researchParticipantToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ studyId: "study-1", tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    })
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining("?token="))
  })
})
