export type NowGateMode = "off" | "shadow" | "enforce"

const rank: Record<NowGateMode, number> = { off: 0, shadow: 1, enforce: 2 }

export function deploymentNowGateMode(): NowGateMode {
  const configured = process.env.NOW_DECISION_GATE_MODE ?? "off"
  if (configured !== "off" && configured !== "shadow" && configured !== "enforce") {
    throw new Error("NOW_DECISION_GATE_MODE must be off, shadow, or enforce.")
  }
  return configured
}

export function effectiveNowGateMode(selectorMode: "shadow" | "enforce"): NowGateMode {
  const deployment = deploymentNowGateMode()
  return rank[deployment] <= rank[selectorMode] ? deployment : selectorMode
}

export function requireNowEnforcement(): void {
  if (deploymentNowGateMode() !== "enforce") throw new Error("Native NOW decision reviews are available only while NOW_DECISION_GATE_MODE=enforce.")
}
