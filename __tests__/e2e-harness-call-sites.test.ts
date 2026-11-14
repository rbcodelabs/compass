import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * Every e2eHarnessEnabled() call site must keep the compile-time elimination the old inline `NODE_ENV !== "production"` had: in an
 * artifact that was not built with COMPASS_E2E_MOCK_AUTH_BUILD=1 the functional-suite fakes must be removed, not merely guarded
 * by a runtime constant. The inline literal is what lets the minifier do that.
 */
const SITES = [
  "app/api/pm-interviews/[interviewId]/apply/route.ts",
  "app/api/pm-interviews/[interviewId]/voice-session/route.ts",
  "app/api/research/respond/route.ts",
  "app/api/research/voice-session/route.ts",
  "lib/research-feature.ts",
  "lib/research-study-service.ts",
  "lib/research-analysis-service.ts",
  "lib/pm-interview-service.ts",
]
const GUARD = '(process.env.NODE_ENV !== "production" || process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1") && e2eHarnessEnabled()'

describe("e2eHarnessEnabled() call sites", () => {
  test.each(SITES)("%s guards every call with the inline build literal", (file) => {
    const text = fs.readFileSync(path.resolve(process.cwd(), file), "utf8")
    const calls = text.split("e2eHarnessEnabled()").length - 1
    const guarded = text.split(GUARD).length - 1
    // One call is the import-free guard text itself, so every call must sit inside a guarded expression.
    expect(guarded).toBeGreaterThan(0)
    expect(guarded).toBe(calls)
  })

  test("the ten sites are all covered", () => {
    const total = SITES.reduce((sum, file) => sum + fs.readFileSync(path.resolve(process.cwd(), file), "utf8").split(GUARD).length - 1, 0)
    expect(total).toBe(10)
  })
})
