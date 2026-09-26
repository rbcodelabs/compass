import { describe, expect, it } from "vitest"
import { classifyActivity, sanitizedPageUrl, activityAction, analyticsCollectionEnabled, safeBrowserPageUrl } from "./activity-policy"

describe("meaningful saved activity", () => {
  it("enables server and browser collection only for valid past production epoch", () => {
    const now = Date.parse("2026-09-23T00:00:00Z")
    expect(analyticsCollectionEnabled("production", "2026-09-22T00:00:00Z", undefined, now)).toBe(true)
    for (const epoch of [undefined, "", "invalid", "2027-01-01"]) expect(analyticsCollectionEnabled("production", epoch, undefined, now)).toBe(false)
    expect(analyticsCollectionEnabled("preview", "2026-09-22T00:00:00Z", undefined, now)).toBe(false)
    expect(analyticsCollectionEnabled("production", "2026-09-22T00:00:00Z", "1", now)).toBe(false)
  })
  it("does not label a repeated conclusion edit as another conclusion event", () => {
    expect(activityAction("experiment", "update", { status: "COMPLETE", conclusionReason: "new reason" })).toBe("experiment_updated")
    expect(activityAction("experiment", "update", { status: "COMPLETE", conclusionReason: "new reason" }, { status: "COMPLETE", conclusionReason: "old" })).toBe("experiment_updated")
    expect(activityAction("experiment", "update", { status: "RUNNING" }, { status: "DESIGNING" })).toBe("experiment_started")
    expect(activityAction("experiment", "update", { status: "COMPLETE" }, { status: "RUNNING" })).toBe("experiment_concluded")
  })
  it.each([["opportunity", "discovery"], ["solution", "discovery"], ["roadmapItem", "delivery"], ["experiment", "learning"], ["experimentResult", "learning"], ["checkIn", "learning"]])("classifies %s creations", (model, layer) => {
    expect(classifyActivity(model, "create", null, { id: "id" })).toBe(layer)
  })
  it("counts substantive edits but not noops, reorders or housekeeping", () => {
    const before = { title: "A", status: "IDEA", sortOrder: 0 }
    expect(classifyActivity("solution", "update", before, { ...before, title: "B" })).toBe("discovery")
    expect(classifyActivity("solution", "update", before, { ...before, sortOrder: 4, updatedAt: new Date() })).toBeNull()
    expect(classifyActivity("solution", "update", before, before)).toBeNull()
    expect(classifyActivity("roadmapItem", "update", { horizon: "NEXT" }, { horizon: "NOW" })).toBe("delivery")
    expect(classifyActivity("roadmapItem", "update", { title: "A" }, { title: "B" })).toBeNull()
    expect(classifyActivity("experiment", "update", { status: "DESIGNING" }, { status: "RUNNING" })).toBe("learning")
  })
  it("excludes arbitrary models, deletes and bulk operations", () => {
    for (const operation of ["delete", "deleteMany", "createMany"]) expect(classifyActivity("solution", operation, {}, {})).toBeNull()
    expect(classifyActivity("metricObservation", "create", null, {})).toBeNull()
  })
})
describe("pageview privacy", () => {
  it("suppresses implicit collector referrers, persisted identities and flag payloads", () => {
    const url = "https://compass.example/acme/private/experiments?token=secret"
    expect(safeBrowserPageUrl(url, "", null, false)).toBe("https://compass.example/:org/:workspace/experiments")
    expect(safeBrowserPageUrl(url, "https://other.example/private?token=secret", null, false)).toBeNull()
    expect(safeBrowserPageUrl(url, "", '{"userId":"private"}', false)).toBeNull()
    expect(safeBrowserPageUrl(url, "", null, true)).toBeNull()
  })
  it("removes tenant names, entity IDs, query strings and hashes", () => {
    expect(sanitizedPageUrl("https://compass.example/acme/private/experiments/secret?token=abc#x")).toBe("https://compass.example/:org/:workspace/experiments/:id")
    expect(sanitizedPageUrl("https://compass.example/acme/private/settings?secret=abc")).toBe("https://compass.example/:org/:workspace/settings")
  })
  it.each(["/login", "/api/auth", "/participate/secret", "/a/b/research/secret", "/a/b/unknown/secret", "/portal/secret", "/research/token/experiments", "/a/b/settings/secret"])("suppresses sensitive/unrecognized route %s", path => expect(sanitizedPageUrl(`https://compass.example${path}`)).toBeNull())
})
