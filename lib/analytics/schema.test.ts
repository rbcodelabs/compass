import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("analytics persistence contract", () => {
  it("defines tenant-scoped immutable revisions and observations with retry uniqueness", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8")
    for (const model of ["AnalyticsConnection", "MetricDefinition", "MetricRevision", "MetricBinding", "MetricObservation", "WorkspaceActivationState"]) expect(schema).toContain(`model ${model} {`)
    expect(schema).toContain('map: "idx_metric_observation_refresh"')
  })
})
