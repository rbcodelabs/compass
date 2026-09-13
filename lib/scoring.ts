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
 * The single source of truth for the MULTIPLICATIVE minValue message, shared
 * by the throwing validator and the value-returning one below so the two can
 * never drift.
 */
function multiplicativeMinValueMessage(key: string): string {
  return (
    `Metric "${key}" must have a minValue greater than 0 for MULTIPLICATIVE formulas ` +
    `(guards against divide-by-zero and keeps the formula monotonic).`
  )
}

/**
 * MULTIPLICATIVE formulas divide by the product of NEGATIVE-direction
 * metrics, so every metric's minValue must be strictly greater than 0 to
 * avoid a divide-by-zero and to keep the formula monotonic/well-defined.
 *
 * Throwing. Retained unchanged for the two callers that want an exception:
 * `computeRawScore`/`theoreticalBounds` (a defensive assertion on a stored
 * formula snapshot, where a violation is a genuine invariant break, not user
 * input) and the MCP handlers, which already wrap it in try/catch → `fail()`.
 *
 * **Do not call this from a server action.** A thrown Server Action error is
 * replaced by Next with an opaque "An error occurred in the Server Components
 * render." in production builds, which destroys the message in transit. Use
 * {@link findMetricConfigIssues} there and return the issues as a value.
 */
export function validateMetricsForFormula(
  metrics: ScoringMetricDef[],
  formulaType: ScoringFormulaType
): void {
  if (formulaType !== "MULTIPLICATIVE") return
  for (const metric of metrics) {
    if (metric.minValue <= 0) {
      throw new Error(multiplicativeMinValueMessage(metric.key))
    }
  }
}

/**
 * The minimum a *new* metric should start at under a given formula.
 *
 * 0 is the natural default for WEIGHTED_SUM but is never valid under
 * MULTIPLICATIVE, where it divides by zero — offering it there hands the user
 * a value guaranteed to be rejected.
 */
export function defaultMinValueForFormula(formulaType: ScoringFormulaType): number {
  return formulaType === "MULTIPLICATIVE" ? 1 : 0
}

/**
 * Re-bases existing metric minimums when the formula type changes.
 *
 * Only a minValue of exactly 0 is rewritten, and only when switching *to*
 * MULTIPLICATIVE. 0 is both the old default and the one value that can never
 * be valid under this formula, so promoting it to 1 cannot destroy a
 * deliberate choice — whereas a typed 0.5, 2 or -3 is real input and is left
 * exactly as entered. A negative minimum is deliberately *not* auto-corrected:
 * it is a genuine mistake, and the user is better served by the explicit error
 * than by a silent guess.
 *
 * Switching back to WEIGHTED_SUM rewrites nothing — 1 is a perfectly valid
 * minimum there, and churning the field on every toggle would be worse than
 * leaving it.
 */
export function rebaseMinValuesForFormula<T extends { minValue: number }>(
  metrics: T[],
  nextFormulaType: ScoringFormulaType
): T[] {
  if (nextFormulaType !== "MULTIPLICATIVE") return metrics
  return metrics.map((m) => (m.minValue === 0 ? { ...m, minValue: 1 } : m))
}

/** Which form input the user has to change to clear a given issue. */
export type MetricConfigIssueField = "key" | "minValue"

export interface MetricConfigIssue {
  /** Position of the offending metric in the submitted array, for field-level display. */
  index: number
  field: MetricConfigIssueField
  /** The offending metric's key (empty string when the key itself is blank). */
  metricKey: string
  message: string
}

/**
 * Value-returning counterpart to {@link validateMetricsForFormula}: reports
 * every way a submitted metric set is invalid, without throwing.
 *
 * Deliberately shared by the server actions and the client form so the two
 * enforce byte-identical rules — the client can pre-validate and surface each
 * issue at its own field, and the server re-checks the same way because a
 * client check is never a trust boundary.
 *
 * Covers three user-caused failures, all of which previously reached the
 * database and surfaced as an opaque masked error:
 *   1. blank key — checked first so a pair of blank rows reports "blank"
 *      rather than a nonsensical `duplicate key ""`.
 *   2. duplicate key — `@@unique([scoringModelId, key])` would otherwise raise
 *      Prisma P2002 *after* the parent ScoringModel row was already written,
 *      leaving an orphan model with zero metrics.
 *   3. MULTIPLICATIVE minValue <= 0 — divide-by-zero guard.
 *
 * Issues are returned in metric order so `issues[0]` is a sensible headline.
 */
export function findMetricConfigIssues(
  metrics: ScoringMetricDef[],
  formulaType: ScoringFormulaType
): MetricConfigIssue[] {
  const issues: MetricConfigIssue[] = []
  const firstIndexByKey = new Map<string, number>()

  metrics.forEach((metric, index) => {
    const key = metric.key?.trim() ?? ""

    if (key === "") {
      issues.push({
        index,
        field: "key",
        metricKey: "",
        message: `Metric ${index + 1} needs a key (a short machine name such as "reach").`,
      })
    } else if (firstIndexByKey.has(key)) {
      issues.push({
        index,
        field: "key",
        metricKey: key,
        message:
          `Duplicate metric key "${key}" (rows ${(firstIndexByKey.get(key) as number) + 1} and ${index + 1}). ` +
          `Each metric in a scoring model needs a unique key.`,
      })
    } else {
      firstIndexByKey.set(key, index)
    }

    if (formulaType === "MULTIPLICATIVE" && metric.minValue <= 0) {
      issues.push({
        index,
        field: "minValue",
        metricKey: key,
        message: multiplicativeMinValueMessage(key || `#${index + 1}`),
      })
    }
  })

  return issues
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
