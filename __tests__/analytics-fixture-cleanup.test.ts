import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
describe("analytics fixture cleanup", () => {
  it("purges tenant-owned analytics in both stale seed cleanup and teardown", () => {
    for (const file of ["e2e/functional/global-teardown.ts", "e2e/functional/fixtures/seed-e2e.ts"]) {
      const source = readFileSync(file, "utf8")
      for (const table of ["metric_observations", "metric_bindings", "metric_revisions", "metric_definitions", "analytics_connections", "workspace_activation_states"]) expect(source.includes(table), `${file} missing ${table}`).toBe(true)
    }
  })
})
