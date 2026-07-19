import { describe, it, expect } from "vitest"
import {
  computeRawScore,
  theoreticalBounds,
  computeScore,
  validateMetricsForFormula,
  type ScoringMetricDef,
} from "@/lib/scoring"

// ─── WEIGHTED_SUM ───────────────────────────────────────────────────────────

describe("computeRawScore — WEIGHTED_SUM", () => {
  const metrics: ScoringMetricDef[] = [
    { key: "reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
    { key: "effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
  ]

  it("sums POSITIVE metrics and subtracts NEGATIVE metrics", () => {
    const raw = computeRawScore(metrics, { reach: 5, effort: 3 }, "WEIGHTED_SUM")
    expect(raw).toBe(2) // 5 - 3
  })

  it("applies per-metric weight before summing", () => {
    const weighted: ScoringMetricDef[] = [
      { key: "reach", minValue: 0, maxValue: 10, weight: 3, direction: "POSITIVE" },
      { key: "effort", minValue: 0, maxValue: 10, weight: 2, direction: "NEGATIVE" },
    ]
    const raw = computeRawScore(weighted, { reach: 5, effort: 3 }, "WEIGHTED_SUM")
    expect(raw).toBe(9) // (3*5) - (2*3) = 15 - 6
  })

  it("treats a missing raw value as 0", () => {
    const raw = computeRawScore(metrics, { reach: 5 }, "WEIGHTED_SUM")
    expect(raw).toBe(5) // effort defaults to 0
  })

  it("sums three or more metrics correctly", () => {
    const three: ScoringMetricDef[] = [
      { key: "reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      { key: "impact", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      { key: "effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    const raw = computeRawScore(three, { reach: 4, impact: 6, effort: 2 }, "WEIGHTED_SUM")
    expect(raw).toBe(8) // 4 + 6 - 2
  })
})

describe("theoreticalBounds — WEIGHTED_SUM", () => {
  it("computes min/max from each metric's best/worst bound for its direction", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
      { key: "effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    const { min, max } = theoreticalBounds(metrics, "WEIGHTED_SUM")
    // worst: reach at min (0), effort at max (-10) => -10
    // best: reach at max (10), effort at min (0) => 10
    expect(min).toBe(-10)
    expect(max).toBe(10)
  })

  it("returns 0/0 for an empty metric set", () => {
    const { min, max } = theoreticalBounds([], "WEIGHTED_SUM")
    expect(min).toBe(0)
    expect(max).toBe(0)
  })
})

describe("computeScore — WEIGHTED_SUM", () => {
  const metrics: ScoringMetricDef[] = [
    { key: "reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
    { key: "effort", minValue: 0, maxValue: 10, weight: 1, direction: "NEGATIVE" },
  ]

  it("normalizes a mid-range score to the expected percentage", () => {
    // rawScore = 5 - 3 = 2; bounds [-10, 10]; normalized = 100*(2-(-10))/20 = 60
    const { rawScore, normalizedScore } = computeScore(metrics, { reach: 5, effort: 3 }, "WEIGHTED_SUM")
    expect(rawScore).toBe(2)
    expect(normalizedScore).toBe(60)
  })

  it("normalizes the worst possible input to 0", () => {
    const { normalizedScore } = computeScore(metrics, { reach: 0, effort: 10 }, "WEIGHTED_SUM")
    expect(normalizedScore).toBe(0)
  })

  it("normalizes the best possible input to 100", () => {
    const { normalizedScore } = computeScore(metrics, { reach: 10, effort: 0 }, "WEIGHTED_SUM")
    expect(normalizedScore).toBe(100)
  })

  it("clamps normalizedScore to 0-100 even if raw values exceed declared bounds", () => {
    const { normalizedScore } = computeScore(metrics, { reach: 999, effort: 0 }, "WEIGHTED_SUM")
    expect(normalizedScore).toBe(100)
  })

  it("returns normalizedScore 0 for a degenerate model with no metrics", () => {
    const { rawScore, normalizedScore } = computeScore([], {}, "WEIGHTED_SUM")
    expect(rawScore).toBe(0)
    expect(normalizedScore).toBe(0)
  })
})

// ─── MULTIPLICATIVE (true RICE) ─────────────────────────────────────────────

describe("computeRawScore — MULTIPLICATIVE", () => {
  const riceMetrics: ScoringMetricDef[] = [
    { key: "reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
    { key: "impact", minValue: 0.25, maxValue: 3, weight: 1, direction: "POSITIVE" },
    { key: "confidence", minValue: 0.1, maxValue: 1, weight: 1, direction: "POSITIVE" },
    { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
  ]

  it("computes Reach × Impact × Confidence ÷ Effort", () => {
    const raw = computeRawScore(
      riceMetrics,
      { reach: 500, impact: 2, confidence: 0.8, effort: 2 },
      "MULTIPLICATIVE"
    )
    expect(raw).toBeCloseTo((500 * 2 * 0.8) / 2, 10) // 400
  })

  it("applies per-metric weight before multiplying", () => {
    const weighted: ScoringMetricDef[] = [
      { key: "reach", minValue: 1, maxValue: 1000, weight: 2, direction: "POSITIVE" },
      { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    const raw = computeRawScore(weighted, { reach: 10, effort: 5 }, "MULTIPLICATIVE")
    expect(raw).toBeCloseTo((2 * 10) / 5, 10) // 4
  })

  it("supports multiple NEGATIVE metrics multiplied into the denominator", () => {
    const multiNeg: ScoringMetricDef[] = [
      { key: "reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
      { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
      { key: "risk", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    const raw = computeRawScore(multiNeg, { reach: 100, effort: 2, risk: 5 }, "MULTIPLICATIVE")
    expect(raw).toBeCloseTo(100 / (2 * 5), 10) // 10
  })

  it("throws at compute time if a NEGATIVE metric's raw value evaluates to 0", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
      { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    expect(() => computeRawScore(metrics, { reach: 100, effort: 0 }, "MULTIPLICATIVE")).toThrow(
      /divide by zero/i
    )
  })
})

describe("validateMetricsForFormula", () => {
  it("does nothing for WEIGHTED_SUM regardless of minValue", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 0, maxValue: 10, weight: 1, direction: "POSITIVE" },
    ]
    expect(() => validateMetricsForFormula(metrics, "WEIGHTED_SUM")).not.toThrow()
  })

  it("throws for MULTIPLICATIVE if any metric has minValue <= 0", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 0, maxValue: 1000, weight: 1, direction: "POSITIVE" },
    ]
    expect(() => validateMetricsForFormula(metrics, "MULTIPLICATIVE")).toThrow(/minValue greater than 0/)
  })

  it("throws for MULTIPLICATIVE if any metric has a negative minValue", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "effort", minValue: -1, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    expect(() => validateMetricsForFormula(metrics, "MULTIPLICATIVE")).toThrow(/minValue greater than 0/)
  })

  it("passes for MULTIPLICATIVE when every metric has minValue > 0", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
      { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    expect(() => validateMetricsForFormula(metrics, "MULTIPLICATIVE")).not.toThrow()
  })

  it("computeRawScore surfaces the same validation error for MULTIPLICATIVE", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 0, maxValue: 1000, weight: 1, direction: "POSITIVE" },
    ]
    expect(() => computeRawScore(metrics, { reach: 500 }, "MULTIPLICATIVE")).toThrow(
      /minValue greater than 0/
    )
  })
})

describe("theoreticalBounds — MULTIPLICATIVE", () => {
  it("computes min as smallest numerator over largest denominator", () => {
    const metrics: ScoringMetricDef[] = [
      { key: "reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
      { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
    ]
    const { min, max } = theoreticalBounds(metrics, "MULTIPLICATIVE")
    expect(min).toBeCloseTo(1 / 10, 10)
    expect(max).toBeCloseTo(1000 / 0.5, 10)
  })
})

describe("computeScore — MULTIPLICATIVE", () => {
  const riceMetrics: ScoringMetricDef[] = [
    { key: "reach", minValue: 1, maxValue: 1000, weight: 1, direction: "POSITIVE" },
    { key: "effort", minValue: 0.5, maxValue: 10, weight: 1, direction: "NEGATIVE" },
  ]

  it("normalizes the worst possible input to 0", () => {
    const { normalizedScore } = computeScore(riceMetrics, { reach: 1, effort: 10 }, "MULTIPLICATIVE")
    expect(normalizedScore).toBeCloseTo(0, 6)
  })

  it("normalizes the best possible input to 100", () => {
    const { normalizedScore } = computeScore(riceMetrics, { reach: 1000, effort: 0.5 }, "MULTIPLICATIVE")
    expect(normalizedScore).toBeCloseTo(100, 6)
  })

  it("normalizes a mid-range RICE score to a stable percentage", () => {
    const { rawScore, normalizedScore } = computeScore(
      riceMetrics,
      { reach: 500, effort: 2 },
      "MULTIPLICATIVE"
    )
    expect(rawScore).toBeCloseTo(250, 10)
    const { min, max } = theoreticalBounds(riceMetrics, "MULTIPLICATIVE")
    expect(normalizedScore).toBeCloseTo((100 * (250 - min)) / (max - min), 6)
  })
})
