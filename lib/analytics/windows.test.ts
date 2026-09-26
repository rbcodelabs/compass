import { describe, expect, it } from "vitest"
import { decodeBindingWindows, resolveFollowupWindow } from "./windows"

describe("binding window policies", () => {
  it.each([
    ["2024-03-01T00:00:00Z", 7, "2024-02-23", "2024-02-29"],
    ["2026-01-01T23:59:59Z", 30, "2025-12-02", "2025-12-31"],
    ["2026-04-01T12:00:00Z", 90, "2026-01-01", "2026-03-31"],
  ] as const)("resolves complete UTC days for %s", (now, days, since, until) => {
    expect(resolveFollowupWindow({ version: 1, mode: "rolling", days }, new Date(now))).toEqual({ since, until })
  })
  it.each([
    [{ since: "2026-01-01", until: "2026-01-02" }, undefined],
    [undefined, { since: "2026-01-01", until: "2026-01-02" }],
    [{ since: "2026-01-01", until: "2026-01-02" }, { version: 1, mode: "rolling", days: 30 }],
    [null, { version: 2, mode: "rolling", days: 30 }],
    [null, { version: 1, mode: "rolling", days: 14 }],
    [{ since: "2026-02-30", until: "2026-03-02" }, { since: "2026-03-03", until: "2026-03-04" }],
  ])("rejects incomplete or invalid policy combinations", (baseline, followup) => {
    expect(() => decodeBindingWindows(baseline, followup)).toThrow("INVALID_WINDOW")
  })
  it("preserves legacy fixed windows exactly", () => {
    const baseline = { since: "2026-01-01", until: "2026-01-02" }, followup = { since: "2026-01-03", until: "2026-01-04" }
    expect(decodeBindingWindows(baseline, followup)).toEqual({ mode: "comparison", baseline, followup })
  })
})
