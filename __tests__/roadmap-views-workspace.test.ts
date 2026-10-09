import { describe, expect, it } from "vitest"
import {
  DEFAULT_ROADMAP_DISPLAY, DEFAULT_ROADMAP_FILTERS, roadmapViewDisplaySchema, roadmapViewFiltersSchema,
} from "@/lib/roadmap-views/schema"
import {
  isWorkspaceStateModified, needsSavedViewExpansion, resolveWorkspaceRoadmapState,
  workspacePageParams, workspaceRoadmapHref, workspaceStateToParams,
} from "@/lib/roadmap-views/workspace"

const SQUAD = "3f1c2a4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b"
const FIELD = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"
const VIEW = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"

const base = { filters: DEFAULT_ROADMAP_FILTERS, display: DEFAULT_ROADMAP_DISPLAY }
const saved = {
  filters: roadmapViewFiltersSchema.parse({ squadIds: [SQUAD], customField: { fieldId: FIELD, value: "Growth" } }),
  display: roadmapViewDisplaySchema.parse({ view: "timeline", groupBy: "squad" }),
}

describe("resolveWorkspaceRoadmapState", () => {
  it("defaults with no params and no saved view", () => {
    expect(resolveWorkspaceRoadmapState({}, null)).toEqual(base)
  })

  it("reads the page's existing params", () => {
    const s = resolveWorkspaceRoadmapState({ squad: SQUAD, field: FIELD, fieldValue: "Growth", groupBy: "none", view: "timeline" }, null)
    expect(s.filters.squadIds).toEqual([SQUAD])
    expect(s.filters.customField).toEqual({ fieldId: FIELD, value: "Growth" })
    expect(s.display).toMatchObject({ groupBy: "none", view: "timeline" })
  })

  it("maps a custom-field id groupBy to groupField and phase to horizon", () => {
    expect(resolveWorkspaceRoadmapState({ groupBy: FIELD }, null).display.groupField).toBe(FIELD)
    expect(resolveWorkspaceRoadmapState({ groupBy: "phase" }, saved).display).toMatchObject({ groupBy: "horizon", groupField: undefined })
  })

  it("uses the saved view as the base and lets explicit params override it", () => {
    const s = resolveWorkspaceRoadmapState({ view: "board" }, saved)
    expect(s.filters.squadIds).toEqual([SQUAD])
    expect(s.display).toMatchObject({ view: "board", groupBy: "squad" })
  })

  it("edited=1 ignores the saved view so a cleared filter stays cleared", () => {
    const s = resolveWorkspaceRoadmapState({ edited: "1", view: "timeline" }, saved)
    expect(s.filters.squadIds).toEqual([])
    expect(s.filters.customField).toBeUndefined()
    expect(s.display.groupBy).toBe("horizon")
  })

  it("drops invalid tokens individually", () => {
    const s = resolveWorkspaceRoadmapState({ squad: "not-a-uuid", field: "nope", fieldValue: "x", groupBy: "???" }, null)
    expect(s.filters.squadIds).toEqual([])
    expect(s.filters.customField).toBeUndefined()
    expect(s.display.groupBy).toBe("horizon")
  })

  it("a field without a value is no filter", () => {
    expect(resolveWorkspaceRoadmapState({ field: FIELD }, null).filters.customField).toBeUndefined()
  })
})

describe("workspace URL round-trip", () => {
  it("omits defaults", () => {
    expect(workspaceStateToParams(base).toString()).toBe("")
    expect(workspaceRoadmapHref("/o/w/roadmap", base)).toBe("/o/w/roadmap")
  })

  it("state -> params -> state is lossless for everything a workspace can express", () => {
    const params = Object.fromEntries(workspaceStateToParams(saved))
    expect(resolveWorkspaceRoadmapState(params, null)).toEqual(saved)
    const grouped = { ...saved, display: { ...saved.display, groupBy: "horizon" as const, groupField: FIELD } }
    expect(resolveWorkspaceRoadmapState(Object.fromEntries(workspaceStateToParams(grouped)), null)).toEqual(grouped)
  })

  it("the href with a saved view is the full edited=1 form", () => {
    const href = workspaceRoadmapHref("/o/w/roadmap", saved, VIEW)
    const query = Object.fromEntries(new URL(href, "http://x").searchParams)
    expect(query).toMatchObject({ saved: VIEW, edited: "1", squad: SQUAD, view: "timeline", groupBy: "squad" })
    // ...and resolving it (even with the saved view supplied) reproduces the state.
    expect(resolveWorkspaceRoadmapState(query, saved)).toEqual(saved)
  })

  it("expands a bare ?saved= but not an already-expanded one", () => {
    expect(needsSavedViewExpansion({ saved: VIEW })).toBe(true)
    expect(needsSavedViewExpansion({ saved: VIEW, squad: SQUAD })).toBe(true)
    expect(needsSavedViewExpansion({ saved: VIEW, edited: "1" })).toBe(false)
    expect(needsSavedViewExpansion({ squad: SQUAD })).toBe(false)
  })

  it("exposes the page's legacy params from a resolved state", () => {
    expect(workspacePageParams(saved)).toEqual({ squad: SQUAD, field: FIELD, fieldValue: "Growth", groupBy: "squad", view: "timeline" })
    expect(workspacePageParams(base)).toEqual({ squad: undefined, field: undefined, fieldValue: undefined, groupBy: undefined, view: "board" })
  })

  it("detects modification against the saved view", () => {
    expect(isWorkspaceStateModified(saved, saved)).toBe(false)
    expect(isWorkspaceStateModified(base, saved)).toBe(true)
    expect(isWorkspaceStateModified(base, null)).toBe(false)
  })
})
