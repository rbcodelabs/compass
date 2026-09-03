import { afterEach, describe, expect, it } from "vitest"
import { deploymentNowGateMode, effectiveNowGateMode } from "@/lib/now-gate-mode"

describe("NOW decision gate mode", () => {
  afterEach(() => { delete process.env.NOW_DECISION_GATE_MODE })
  it("defaults fail-safe for rollout to off", () => {
    expect(deploymentNowGateMode()).toBe("off")
  })
  it("rejects an unknown deployment mode", () => {
    process.env.NOW_DECISION_GATE_MODE = "enabled"
    expect(() => deploymentNowGateMode()).toThrow(/off, shadow, or enforce/)
  })
  it("lets deployment configuration downgrade but never elevate a signed selector", () => {
    process.env.NOW_DECISION_GATE_MODE = "shadow"
    expect(effectiveNowGateMode("enforce")).toBe("shadow")
    process.env.NOW_DECISION_GATE_MODE = "enforce"
    expect(effectiveNowGateMode("shadow")).toBe("shadow")
    process.env.NOW_DECISION_GATE_MODE = "off"
    expect(effectiveNowGateMode("enforce")).toBe("off")
  })
})
