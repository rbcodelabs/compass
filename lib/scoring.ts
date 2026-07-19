/**
 * Pure formula engine for Opportunity scoring models.
 *
 * Framework-free — no Prisma, no Next.js — so it's trivial to unit test
 * exhaustively. Both callers (server actions and MCP tool handlers) compute
 * scores through this module so the semantics never drift between the two
 * surfaces.
 *
 * Both formula types are per-metric monotonic (each metric independently
 * makes the score better or worse as its raw value moves toward its max or
 * min), so theoretical bounds can be computed directly from the metric
 * definitions without search.
 */

export type ScoringFormulaType = "WEIGHTED_SUM" | "MULTIPLICATIVE"
export type MetricDirection = "POSITIVE" | "NEGATIVE"

export interface ScoringMetricDef {
  key: string
  minValue: number
  maxValue: number
  weight: number
  direction: MetricDirection
}

/**
 * MULTIPLICATIVE formulas divide by the product of NEGATIVE-direction
 * metrics, so every metric's minValue must be strictly greater than 0 to
 * avoid a divide-by-zero and to keep the formula monotonic/well-defined.
 * Call this at scoring-model create/update time (before persisting) and
 * defensively before computing a score.
 */
export function validateMetricsForFormula(
  metrics: ScoringMetricDef[],
  formulaType: ScoringFormulaType
): void {
  if (formulaType !== "MULTIPLICATIVE") return
  for (const metric of metrics) {
    if (metric.minValue <= 0) {
      throw new Error(
        `Metric "${metric.key}" must have a minValue greater than 0 for MULTIPLICATIVE formulas ` +
          `(guards against divide-by-zero and keeps the formula monotonic).`
      )
    }
  }
}

function effectiveValue(metric: ScoringMetricDef, rawValue: number): number {
  return metric.weight * rawValue
}

/**
 * rawScore = Σ (POSITIVE: +effectiveValue, NEGATIVE: -effectiveValue) for WEIGHTED_SUM
 * rawScore = Π(POSITIVE effectiveValue) / Π(NEGATIVE effectiveValue) for MULTIPLICATIVE
 */
export function computeRawScore(
  metrics: ScoringMetricDef[],
  rawValues: Record<string, number>,
  formulaType: ScoringFormulaType
): number {
  if (formulaType === "WEIGHTED_SUM") {
    return metrics.reduce((sum, metric) => {
      const ev = effectiveValue(metric, rawValues[metric.key] ?? 0)
      return sum + (metric.direction === "POSITIVE" ? ev : -ev)
    }, 0)
  }

  // MULTIPLICATIVE
  validateMetricsForFormula(metrics, formulaType)
  let numerator = 1
  let denominator = 1
  for (const metric of metrics) {
    const ev = effectiveValue(metric, rawValues[metric.key] ?? 0)
    if (metric.direction === "POSITIVE") numerator *= ev
    else denominator *= ev
  }
  if (denominator === 0) {
    throw new Error(
      "Divide by zero computing a MULTIPLICATIVE score — a NEGATIVE-direction metric evaluated to 0."
    )
  }
  return numerator / denominator
}

/**
 * Computes the theoretical min/max achievable rawScore for a set of metrics
 * under a formula type, by evaluating each metric at whichever bound
 * (min or max) is best/worst for its direction.
 */
export function theoreticalBounds(
  metrics: ScoringMetricDef[],
  formulaType: ScoringFormulaType
): { min: number; max: number } {
  if (formulaType === "WEIGHTED_SUM") {
    let min = 0
    let max = 0
    for (const metric of metrics) {
      const evAtMin = effectiveValue(metric, metric.minValue)
      const evAtMax = effectiveValue(metric, metric.maxValue)
      if (metric.direction === "POSITIVE") {
        // Worst case contributes as little as possible; best case as much as possible.
        min += evAtMin
        max += evAtMax
      } else {
        // Worst case subtracts as much as possible; best case subtracts as little as possible.
        min += -evAtMax
        max += -evAtMin
      }
    }
    return { min, max }
  }

  // MULTIPLICATIVE — numerator at max/min, denominator at min/max respectively.
  validateMetricsForFormula(metrics, formulaType)
  let numMin = 1
  let numMax = 1
  let denMin = 1
  let denMax = 1
  for (const metric of metrics) {
    const evAtMin = effectiveValue(metric, metric.minValue)
    const evAtMax = effectiveValue(metric, metric.maxValue)
    if (metric.direction === "POSITIVE") {
      numMin *= evAtMin
      numMax *= evAtMax
    } else {
      denMin *= evAtMin
      denMax *= evAtMax
    }
  }
  // Worst score: smallest numerator over largest denominator.
  // Best score: largest numerator over smallest denominator.
  const min = denMax === 0 ? 0 : numMin / denMax
  const max = denMin === 0 ? 0 : numMax / denMin
  return { min, max }
}

/**
 * normalizedScore = clamp(100 * (rawScore - theoreticalMin) / (theoreticalMax - theoreticalMin), 0, 100)
 *
 * This is what makes scores comparable across workspaces using different
 * templates/scales — every score is expressed as "how close to the best
 * possible outcome under its own formula", 0-100.
 */
export function computeScore(
  metrics: ScoringMetricDef[],
  rawValues: Record<string, number>,
  formulaType: ScoringFormulaType
): { rawScore: number; normalizedScore: number } {
  const rawScore = computeRawScore(metrics, rawValues, formulaType)
  const { min, max } = theoreticalBounds(metrics, formulaType)

  if (max === min) {
    // Degenerate model (e.g. zero metrics, or every metric has min === max).
    return { rawScore, normalizedScore: 0 }
  }

  const normalizedScore = Math.min(100, Math.max(0, (100 * (rawScore - min)) / (max - min)))
  return { rawScore, normalizedScore }
}
