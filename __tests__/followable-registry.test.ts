import { afterEach, describe, expect, it, vi } from "vitest"
import { COMMENT_TARGET_TYPES } from "@/lib/comments"
import {
  FOLLOWABLE_SUBJECT_TYPES,
  followableConfig,
  getFollowable,
  isSubjectTypeActive,
  listFollowableTypes,
  viewerIdsFor,
} from "@/lib/followable"
import { deleteSubjectFollowState } from "@/lib/follow-cleanup"
import { createFakeFollowDb } from "./helpers/fake-follow-db"

const research = vi.hoisted(() => ({ enabled: true }))
vi.mock("@/lib/research-feature", () => ({ isResearchCaptureEnabled: () => research.enabled }))

const WS = "00000000-0000-4000-8000-000000000001"

afterEach(() => {
  followableConfig.shippedSlice = 1
  vi.unstubAllEnvs()
})

describe("subject registry completeness", () => {
  it("reuses the comment target vocabulary exactly and adds only METRIC", () => {
    expect([...FOLLOWABLE_SUBJECT_TYPES].sort()).toEqual([...COMMENT_TARGET_TYPES, "METRIC"].sort())
  })

  it("has a full definition for every followable type", () => {
    for (const type of FOLLOWABLE_SUBJECT_TYPES) {
      const def = getFollowable(type)
      expect(def, type).not.toBeNull()
      expect(typeof def!.resolveWorkspace, type).toBe("function")
      expect(typeof def!.resolveDisplay, type).toBe("function")
      expect([2, 3, "deferred"], type).toContain(def!.slice)
      expect(typeof def!.emitsStatus, type).toBe("boolean")
      expect(typeof def!.emitsComments, type).toBe("boolean")
      expect(def!.emitsStatus || def!.emitsComments || def!.emitsAssignment, `${type} emits nothing`).toBeTruthy()
    }
    expect(listFollowableTypes()).toHaveLength(FOLLOWABLE_SUBJECT_TYPES.length)
  })

  it("has a follow-state cleanup path that accepts every registry type", async () => {
    // Enumerates the registry rather than a hand-kept list, so a newly added
    // subject type cannot ship without a working cleanup call.
    for (const type of FOLLOWABLE_SUBJECT_TYPES) {
      const { db } = createFakeFollowDb()
      await expect(deleteSubjectFollowState(type, ["00000000-0000-4000-8000-0000000000aa"], db), type).resolves.toBeUndefined()
    }
  })

  it("rejects unknown types", () => {
    expect(getFollowable("PORTAL_ACCOUNT")).toBeNull()
    expect(isSubjectTypeActive("PORTAL_ACCOUNT")).toBe(false)
  })
})

describe("ADR slice and event scope", () => {
  it("puts Opportunity, Solution, Task and Doc in slice 2 and the rest in slice 3", () => {
    const slice2 = FOLLOWABLE_SUBJECT_TYPES.filter((t) => getFollowable(t)!.slice === 2).sort()
    expect(slice2).toEqual(["DOC", "OPPORTUNITY", "SOLUTION", "TASK"])
    for (const type of ["EXPERIMENT", "ROADMAP_ITEM", "ASSUMPTION", "OBJECTIVE", "KEY_RESULT", "FEEDBACK_ITEM", "REVIEW_REQUEST", "METRIC", "RESEARCH_STUDY"] as const) {
      expect(getFollowable(type)!.slice, type).toBe(3)
    }
  })

  it("keeps Docs comment-only, Metrics status-only and only Tasks assignable", () => {
    expect(getFollowable("DOC")).toMatchObject({ emitsComments: true, emitsStatus: false })
    expect(getFollowable("METRIC")).toMatchObject({ emitsComments: false, emitsStatus: true })
    expect(FOLLOWABLE_SUBJECT_TYPES.filter((t) => getFollowable(t)!.emitsAssignment)).toEqual(["TASK"])
  })

  it("defers Artifacts entirely (open question 3: no recommendation, conservative)", () => {
    expect(getFollowable("ARTIFACT")!.slice).toBe("deferred")
    followableConfig.shippedSlice = 3
    expect(isSubjectTypeActive("ARTIFACT")).toBe(false)
  })
})

describe("slice gate", () => {
  it("activates no subject type until slice 2 ships, then slice 3", () => {
    expect(FOLLOWABLE_SUBJECT_TYPES.filter(isSubjectTypeActive)).toEqual([])
    followableConfig.shippedSlice = 2
    expect(FOLLOWABLE_SUBJECT_TYPES.filter(isSubjectTypeActive).sort()).toEqual(["DOC", "OPPORTUNITY", "SOLUTION", "TASK"])
    followableConfig.shippedSlice = 3
    expect(isSubjectTypeActive("METRIC")).toBe(true)
    expect(isSubjectTypeActive("ARTIFACT")).toBe(false)
  })
})

describe("viewerIdsFor", () => {
  it("keeps only current workspace members", async () => {
    const { db, member } = createFakeFollowDb()
    member(WS, "u1")
    member("other-workspace", "u2")
    await expect(viewerIdsFor("TASK", WS, ["u1", "u2", "u3"], db)).resolves.toEqual(["u1"])
  })

  it("denies research studies when research capture is off, allows them when on", async () => {
    const { db, member } = createFakeFollowDb()
    member(WS, "u1")
    research.enabled = false
    const off = await viewerIdsFor("RESEARCH_STUDY", WS, ["u1"], db)
    research.enabled = true
    const on = await viewerIdsFor("RESEARCH_STUDY", WS, ["u1"], db)
    expect([off, on]).toEqual([[], ["u1"]])
  })
})
