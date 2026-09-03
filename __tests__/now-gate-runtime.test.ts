import { beforeEach, describe, expect, it, vi } from "vitest"
const { prisma, resolve, inspectPolicy } = vi.hoisted(() => ({
  prisma: { roadmapItem: { findFirst: vi.fn(), update: vi.fn() }, nowGateEvaluation: { create: vi.fn() } },
  resolve: vi.fn(),
  inspectPolicy: vi.fn(),
}))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/now-eligibility", () => ({ defaultNowEligibilityResolver: { resolve }, inspectConfiguredNowPolicy: inspectPolicy }))
import { evaluateDirectNowIngress, finalizeCreatedNowIngress, initialHorizonForNowCreate } from "@/lib/now-gate-runtime"

const item = { id: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002", title: "Candidate", description: null, horizon: "NEXT", status: "ACTIVE", solutionId: null, opportunityId: null, squadId: null, startDate: null, endDate: null, isPrivate: false, sortOrder: 0, updatedAt: new Date(), nowCommitmentProvenance: "LEGACY_UNGATED" }

describe("NOW gate runtime modes", () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.NOW_DECISION_GATE_MODE; prisma.roadmapItem.findFirst.mockResolvedValue(item); prisma.nowGateEvaluation.create.mockResolvedValue({ id: "audit" }); inspectPolicy.mockReturnValue({ runtimePolicyReady: true, selectorMode: "enforce", effectiveMode: "shadow" }) })
  it("returns before any gate or audit query while off", async () => {
    await expect(evaluateDirectNowIngress({ workspaceId: item.workspaceId, roadmapItemId: item.id, currentHorizon: "NEXT", requestedHorizon: "NOW", ingressKey: "ui.move", actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" } })).resolves.toMatchObject({ mode: "off", outcome: null })
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
  it("creates directly in NOW without policy or telemetry access while off", async () => {
    const initial = initialHorizonForNowCreate as unknown as (requested: string, workspaceId: string) => string
    expect(initial("NOW", item.workspaceId)).toBe("NOW")
    await expect(finalizeCreatedNowIngress({
      workspaceId: item.workspaceId,
      roadmapItemId: item.id,
      requestedHorizon: "NOW",
      ingressKey: "ui.roadmap.add",
      actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" },
    })).resolves.toMatchObject({ mode: "off", outcome: null })
    expect(inspectPolicy).not.toHaveBeenCalled()
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled()
    expect(prisma.roadmapItem.update).not.toHaveBeenCalled()
    expect(prisma.nowGateEvaluation.create).not.toHaveBeenCalled()
  })
  it("uses provisional NEXT, audits once, then restores NOW in effective shadow", async () => {
    process.env.NOW_DECISION_GATE_MODE = "enforce"
    inspectPolicy.mockReturnValue({ runtimePolicyReady: true, selectorMode: "shadow", effectiveMode: "shadow" })
    resolve.mockRejectedValue(Object.assign(new Error("not eligible"), { code: "NO_APPLIED_INVESTMENT_DECISION" }))
    const initial = initialHorizonForNowCreate as unknown as (requested: string, workspaceId: string) => string
    expect(initial("NOW", item.workspaceId)).toBe("NEXT")

    await expect(finalizeCreatedNowIngress({
      workspaceId: item.workspaceId,
      roadmapItemId: item.id,
      requestedHorizon: "NOW",
      ingressKey: "ui.roadmap.add",
      actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" },
    })).resolves.toMatchObject({ mode: "shadow", outcome: "WOULD_BLOCK" })
    expect(prisma.nowGateEvaluation.create).toHaveBeenCalledTimes(1)
    expect(prisma.roadmapItem.update).toHaveBeenCalledWith({
      where: { id: item.id },
      data: { horizon: "NOW", updatedAt: expect.any(Date) },
    })
  })
  it("preserves the legacy NOW mutation but marks evidence incomplete when shadow telemetry fails", async () => {
    process.env.NOW_DECISION_GATE_MODE = "shadow"
    resolve.mockRejectedValue(Object.assign(new Error("not eligible"), { code: "NO_APPLIED_INVESTMENT_DECISION" }))
    prisma.nowGateEvaluation.create.mockRejectedValue(new Error("telemetry unavailable"))
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(finalizeCreatedNowIngress({
      workspaceId: item.workspaceId,
      roadmapItemId: item.id,
      requestedHorizon: "NOW",
      ingressKey: "ui.roadmap.add",
      actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" },
      correlationId: "00000000-0000-4000-8000-000000000005",
    })).resolves.toEqual(expect.objectContaining({
      mode: "shadow",
      evidenceIncomplete: true,
      operationalError: "SHADOW_TELEMETRY_WRITE_FAILED",
    }))
    expect(prisma.roadmapItem.update).toHaveBeenCalledWith({
      where: { id: item.id },
      data: { horizon: "NOW", updatedAt: expect.any(Date) },
    })
    expect(consoleError).toHaveBeenCalledWith("[now-gate-shadow] SHADOW_TELEMETRY_WRITE_FAILED", {
      correlationId: "00000000-0000-4000-8000-000000000005",
    })
    consoleError.mockRestore()
  })
  it("rejects effective enforce before a create caller can insert a provisional row", () => {
    process.env.NOW_DECISION_GATE_MODE = "enforce"
    inspectPolicy.mockReturnValue({ runtimePolicyReady: true, selectorMode: "enforce", effectiveMode: "enforce" })
    const initial = initialHorizonForNowCreate as unknown as (requested: string, workspaceId: string) => string
    expect(() => initial("NOW", item.workspaceId)).toThrowError(expect.objectContaining({ code: "DECISION_REQUIRED" }))
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled()
    expect(prisma.roadmapItem.update).not.toHaveBeenCalled()
    expect(prisma.nowGateEvaluation.create).not.toHaveBeenCalled()
  })
  it("records a sanitized WOULD_BLOCK and does not block legacy transition in shadow", async () => {
    process.env.NOW_DECISION_GATE_MODE = "shadow"
    resolve.mockRejectedValue({ code: "NO_APPLIED_INVESTMENT_DECISION" })
    await expect(evaluateDirectNowIngress({ workspaceId: item.workspaceId, roadmapItemId: item.id, currentHorizon: "NEXT", requestedHorizon: "NOW", ingressKey: "ui.move", actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" } })).resolves.toMatchObject({ outcome: "WOULD_BLOCK", evidenceIncomplete: false })
    expect(prisma.nowGateEvaluation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ mode: "SHADOW", outcome: "WOULD_BLOCK", blockerCode: "NO_APPLIED_INVESTMENT_DECISION", workspaceId: item.workspaceId }) })
  })
  it.each([
    ["workspace", { workspaceId: "not-a-uuid" }, "WORKSPACE_INVALID"],
    ["roadmap item", { roadmapItemId: "not-a-uuid" }, "ITEM_INVALID"],
    ["actor", { actor: { kind: "USER", id: "not-a-uuid" } }, "ACTOR_INVALID"],
    ["correlation", { correlationId: "not-a-uuid" }, "CORRELATION_INVALID"],
  ])("rejects an invalid %s identity before querying or writing telemetry", async (_label, override, code) => {
    process.env.NOW_DECISION_GATE_MODE = "shadow"
    await expect(evaluateDirectNowIngress({
      workspaceId: item.workspaceId,
      roadmapItemId: item.id,
      currentHorizon: "NEXT",
      requestedHorizon: "NOW",
      ingressKey: "ui.move",
      actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" },
      ...(override as Partial<Parameters<typeof evaluateDirectNowIngress>[0]>),
    })).rejects.toEqual(expect.objectContaining({ code }))
    expect(prisma.roadmapItem.findFirst).not.toHaveBeenCalled()
    expect(prisma.nowGateEvaluation.create).not.toHaveBeenCalled()
  })
  it("blocks direct NOW admission before policy queries while enforce", async () => {
    process.env.NOW_DECISION_GATE_MODE = "enforce"
    inspectPolicy.mockReturnValue({ runtimePolicyReady: true, selectorMode: "enforce", effectiveMode: "enforce" })
    await expect(evaluateDirectNowIngress({ workspaceId: item.workspaceId, roadmapItemId: item.id, currentHorizon: "NEXT", requestedHorizon: "NOW", ingressKey: "ui.move", actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" } })).rejects.toEqual(expect.objectContaining({ code: "DECISION_REQUIRED" }))
    expect(resolve).not.toHaveBeenCalled()
  })
  it("honors a signed shadow selector when deployment configuration is enforce", async () => {
    process.env.NOW_DECISION_GATE_MODE = "enforce"
    inspectPolicy.mockReturnValue({ runtimePolicyReady: true, selectorMode: "shadow", effectiveMode: "shadow" })
    resolve.mockRejectedValue(Object.assign(new Error("not eligible"), { code: "NO_APPLIED_INVESTMENT_DECISION" }))

    await expect(evaluateDirectNowIngress({
      workspaceId: item.workspaceId,
      roadmapItemId: item.id,
      currentHorizon: "NEXT",
      requestedHorizon: "NOW",
      ingressKey: "ui.move",
      actor: { kind: "USER", id: "00000000-0000-4000-8000-000000000003" },
    })).resolves.toMatchObject({ mode: "shadow", outcome: "WOULD_BLOCK" })
    expect(prisma.nowGateEvaluation.create).toHaveBeenCalledTimes(1)
  })
})
