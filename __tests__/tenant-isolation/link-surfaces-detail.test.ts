/**
 * Phase 4B detail payloads, against the shared two-tenant fake: the Solution panel's Key Result options and the Key Result
 * panel's "Linked solutions" are produced only for presets that offer the Solution <-> Key Result link, are filtered by
 * workspace on BOTH endpoints (a NULL-workspace Solution or a Key Result under a NULL-workspace Objective is hidden), and
 * leave the CLASSIC payload exactly as it was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_A, WS_B, createTenantFakePrisma } from "../helpers/tenant-fake-prisma"

const fake = vi.hoisted(() => ({ current: null as null | ReturnType<typeof createTenantFakePrisma> }))

// The fake models the link and ownership graph, not every panel relation (artifacts, tasks, scores, evidence): those
// unrelated reads are stubbed so these tests exercise exactly the Phase 4B additions.
vi.mock("@/lib/db", () => ({
  default: () => ({
    ...fake.current!.client,
    artifactLink: { findMany: async () => [] },
    artifact: { findMany: async () => [] },
    workspaceScoringConfig: { findUnique: async () => null },
  }),
}))
vi.mock("@/auth", () => ({ auth: async () => null }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/linked-tasks", () => ({ fetchLinkedTasksBundle: async () => ({ deliveryTasks: [], linkableTasks: [], members: [] }) }))
vi.mock("@/lib/custom-field-definitions", () => ({ loadCustomFieldsForObject: async () => [] }))
vi.mock("@/lib/evidence-provenance", () => ({ loadEvidenceProvenance: async () => new Map(), withEvidenceProvenance: (rows: unknown[]) => rows }))
vi.mock("@/lib/score-summary", () => ({ toSolutionScoreData: () => null, toOpportunityScoreData: () => null, toScoreSummary: () => null }))

import { getEntityDetail } from "@/lib/entity-detail"

const state = () => fake.current!.state
const seed = (row: Record<string, unknown>) =>
  state().solutionKeyResultLinks.push({ id: `l-${state().solutionKeyResultLinks.length + 1}`, source: "UI", createdById: null, createdAt: new Date(10 + state().solutionKeyResultLinks.length), ...row })
const setPreset = (thinkingModel: string | null) => {
  state().workspaces.find((w) => w.id === WS_A.id)!.thinkingModel = thinkingModel
}

beforeEach(() => {
  fake.current = createTenantFakePrisma()
})

describe("Solution detail", () => {
  it("TORRES_OST: offers this workspace's key results only, and lists the linked ones", async () => {
    setPreset("TORRES_OST")
    seed({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" })
    const detail = await getEntityDetail("solution", "sol-a", WS_A.id)
    const data = detail!.data as unknown as { availableKeyResults: Array<{ id: string }>; linkedKeyResults: Array<{ id: string }> }
    expect(data.availableKeyResults.map((k) => k.id)).toEqual(["kr-a"])
    expect(data.linkedKeyResults.map((k) => k.id)).toEqual(["kr-a"])
  })

  it("hides a link row that points at a foreign or NULL-workspace key result", async () => {
    setPreset("OPPORTUNITY_FIRST_OKR")
    seed({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-b" })
    seed({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-null" })
    const data = (await getEntityDetail("solution", "sol-a", WS_A.id))!.data as unknown as { linkedKeyResults: unknown[]; availableKeyResults: Array<{ id: string }> }
    expect(data.linkedKeyResults).toEqual([])
    expect(data.availableKeyResults.map((k) => k.id)).toEqual(["kr-a"])
  })

  it("CLASSIC (and NULL): no option list and no new fields at all", async () => {
    for (const preset of [null, "CLASSIC"]) {
      setPreset(preset)
      const data = (await getEntityDetail("solution", "sol-a", WS_A.id))!.data as unknown as Record<string, unknown>
      expect("availableKeyResults" in data).toBe(false)
    }
  })

  it("a missing link table FAILS the solution read with the database error (no silent empty list)", async () => {
    setPreset("TORRES_OST")
    const missing = Object.assign(new Error('relation "solution_key_result_links" does not exist'), { code: "42P01" })
    const client = fake.current!.client as unknown as { solutionKeyResultLink: { findMany: unknown } }
    client.solutionKeyResultLink.findMany = async () => {
      throw missing
    }
    await expect(getEntityDetail("solution", "sol-a", WS_A.id)).rejects.toBe(missing)
  })

  it("a foreign or NULL-workspace solution resolves to nothing, so no option list leaks", async () => {
    setPreset("TORRES_OST")
    await expect(getEntityDetail("solution", "sol-b", WS_A.id)).resolves.toBeNull()
    await expect(getEntityDetail("solution", "sol-null", WS_A.id)).resolves.toBeNull()
  })
})

describe("Key Result detail", () => {
  it("TORRES_OST: lists the linked solutions, hiding a NULL-workspace or foreign solution", async () => {
    setPreset("TORRES_OST")
    seed({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" })
    seed({ workspaceId: WS_A.id, solutionId: "sol-null", keyResultId: "kr-a" })
    seed({ workspaceId: WS_A.id, solutionId: "sol-b", keyResultId: "kr-a" })
    const data = (await getEntityDetail("keyResult", "kr-a", WS_A.id))!.data as unknown as { linkedSolutions: Array<{ id: string; title: string }> }
    expect(data.linkedSolutions).toEqual([{ id: "sol-a", title: "A solution" }])
  })

  it("CLASSIC: no linkedSolutions field", async () => {
    setPreset(null)
    seed({ workspaceId: WS_A.id, solutionId: "sol-a", keyResultId: "kr-a" })
    const data = (await getEntityDetail("keyResult", "kr-a", WS_A.id))!.data as unknown as Record<string, unknown>
    expect("linkedSolutions" in data).toBe(false)
  })

  it("a foreign or NULL-workspace key result resolves to nothing", async () => {
    setPreset("TORRES_OST")
    await expect(getEntityDetail("keyResult", "kr-b", WS_A.id)).resolves.toBeNull()
    await expect(getEntityDetail("keyResult", "kr-null", WS_A.id)).resolves.toBeNull()
    await expect(getEntityDetail("keyResult", "kr-a", WS_B.id)).resolves.toBeNull()
  })

  it("a missing link table FAILS the key result read with the database error (no silent empty list)", async () => {
    setPreset("TORRES_OST")
    const missing = Object.assign(new Error("missing"), { code: "P2021" })
    const client = fake.current!.client as unknown as { solutionKeyResultLink: { findMany: unknown } }
    client.solutionKeyResultLink.findMany = async () => {
      throw missing
    }
    await expect(getEntityDetail("keyResult", "kr-a", WS_A.id)).rejects.toBe(missing)
  })

  it("CLASSIC never reads the link table for a key result, so it is unaffected by a missing one", async () => {
    setPreset(null)
    const client = fake.current!.client as unknown as { solutionKeyResultLink: { findMany: unknown } }
    client.solutionKeyResultLink.findMany = async () => {
      throw new Error("must not be read under CLASSIC")
    }
    await expect(getEntityDetail("keyResult", "kr-a", WS_A.id)).resolves.not.toBeNull()
  })
})
