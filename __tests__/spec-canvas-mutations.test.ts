import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ addSolution: vi.fn(), addAssumption: vi.fn(), createExperiment: vi.fn(), patchEntityField: vi.fn() }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({ addSolution: m.addSolution, addAssumption: m.addAssumption }))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({ createExperiment: m.createExperiment }))
vi.mock("@/components/panels/panel-parts", () => ({ patchEntityField: m.patchEntityField }))
import { createSpecAssumption, createSpecExperiment, createSpecSolution, EXPERIMENT_PLACEHOLDER, normalizeTitle, saveSpecField, SpecValidationError } from "@/lib/spec-canvas/mutations"

const ctx = { orgSlug: "acme", workspaceSlug: "growth", workspaceId: "ws-1", opportunityId: "opp-1" }
beforeEach(() => vi.resetAllMocks())

describe("normalizeTitle", () => {
  it("trims, and rejects empty or over-long titles", () => {
    expect(normalizeTitle("  hi ")).toBe("hi")
    expect(() => normalizeTitle("   ")).toThrow(SpecValidationError)
    expect(() => normalizeTitle("x".repeat(256))).toThrow(SpecValidationError)
  })
})

describe("saveSpecField", () => {
  it("goes through the scoped panel PATCH with the workspace slugs", async () => {
    await saveSpecField(ctx, "assumption", "a1", "riskLevel", "HIGH")
    expect(m.patchEntityField).toHaveBeenCalledWith("assumption", "a1", "acme", "growth", "riskLevel", "HIGH")
  })
  it("trims titles and sends a cleared description as null", async () => {
    await saveSpecField(ctx, "solution", "s1", "title", "  New  ")
    await saveSpecField(ctx, "solution", "s1", "description", null)
    expect(m.patchEntityField).toHaveBeenNthCalledWith(1, "solution", "s1", "acme", "growth", "title", "New")
    expect(m.patchEntityField).toHaveBeenNthCalledWith(2, "solution", "s1", "acme", "growth", "description", null)
  })
  it("refuses empty titles, empty hypotheses and fields the card does not edit, without calling the server", async () => {
    await expect(saveSpecField(ctx, "solution", "s1", "title", " ")).rejects.toThrow(SpecValidationError)
    await expect(saveSpecField(ctx, "experiment", "e1", "hypothesis", " ")).rejects.toThrow(SpecValidationError)
    await expect(saveSpecField(ctx, "experiment", "e1", "riskLevel", "HIGH")).rejects.toThrow(SpecValidationError)
    await expect(saveSpecField(ctx, "opportunity", "o1", "riskLevel", "HIGH")).rejects.toThrow(SpecValidationError)
    expect(m.patchEntityField).not.toHaveBeenCalled()
  })
  it("propagates a server failure so the caller can revert", async () => {
    m.patchEntityField.mockRejectedValue(new Error("save failed"))
    await expect(saveSpecField(ctx, "solution", "s1", "title", "x")).rejects.toThrow("save failed")
  })
})

describe("creation", () => {
  it("creates a solution under the opportunity and returns a canvas row", async () => {
    m.addSolution.mockResolvedValue({ id: "s9", title: "T", description: null, status: "IDEA", seqPrefix: "SOL", seqNumber: 3 })
    const created = await createSpecSolution(ctx, "  T ")
    expect(m.addSolution).toHaveBeenCalledWith("opp-1", { title: "T" }, "/acme/growth/discovery/opp-1")
    expect(created).toMatchObject({ id: "s9", displayId: "SOL-3", status: "IDEA", assumptionCount: 0 })
  })
  it("creates an assumption pre-linked to its solution", async () => {
    m.addAssumption.mockResolvedValue({ id: "a9", title: "A", description: null, riskLevel: "MEDIUM", status: "UNTESTED", seqPrefix: null, seqNumber: null })
    const created = await createSpecAssumption(ctx, { id: "s1", title: "Sol" }, "A")
    expect(m.addAssumption).toHaveBeenCalledWith("s1", { title: "A", riskLevel: "MEDIUM" }, "/acme/growth/discovery/opp-1")
    expect(created).toMatchObject({ id: "a9", solutionId: "s1", solutionTitle: "Sol", riskTone: "warning" })
  })
  it("creates an experiment linked to its assumption in the workspace", async () => {
    m.createExperiment.mockResolvedValue({ id: "e9", title: "E", hypothesis: "E", status: "DESIGNING", conclusion: null, conclusionReason: null, seqPrefix: "EXP", seqNumber: 7 })
    const created = await createSpecExperiment(ctx, { id: "a1", title: "Asm" }, "E")
    expect(m.createExperiment).toHaveBeenCalledWith("ws-1", { title: "E", hypothesis: "E", method: EXPERIMENT_PLACEHOLDER, killCondition: EXPERIMENT_PLACEHOLDER, assumptionId: "a1" })
    expect(created).toMatchObject({ id: "e9", assumptionId: "a1", assumptionTitle: "Asm", displayId: "EXP-7" })
  })
  it("rejects blank titles before any server call", async () => {
    await expect(createSpecSolution(ctx, " ")).rejects.toThrow(SpecValidationError)
    await expect(createSpecAssumption(ctx, { id: "s", title: "" }, "")).rejects.toThrow(SpecValidationError)
    await expect(createSpecExperiment(ctx, { id: "a", title: "" }, "")).rejects.toThrow(SpecValidationError)
    expect(m.addSolution).not.toHaveBeenCalled()
    expect(m.addAssumption).not.toHaveBeenCalled()
    expect(m.createExperiment).not.toHaveBeenCalled()
  })
})
