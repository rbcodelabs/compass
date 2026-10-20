/**
 * Enum choices the canvas offers for in-place status changes. They mirror what
 * `updateEntityField` (lib/entity-mutations.ts) accepts, so the pickers never
 * offer a value the server would reject. NOT_PURSUED is deliberately absent for
 * experiments: it is set by concluding an experiment, not by a bare status edit.
 */
import { humanizeEnum } from "./shape"

export type EnumOption = { value: string; label: string }

const options = (values: readonly string[]): EnumOption[] => values.map((value) => ({ value, label: humanizeEnum(value) }))

export const OPPORTUNITY_STATUS_OPTIONS = options(["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE", "ARCHIVED"])
export const SOLUTION_STATUS_OPTIONS = options(["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"])
export const ASSUMPTION_STATUS_OPTIONS = options(["UNTESTED", "TESTING", "VALIDATED", "INVALIDATED"])
export const RISK_LEVEL_OPTIONS = options(["HIGH", "MEDIUM", "LOW"])
export const EXPERIMENT_STATUS_OPTIONS = options(["DESIGNING", "RUNNING", "COMPLETE", "KILLED"])

/** The options plus the current value when it is not selectable (e.g. an experiment already NOT_PURSUED). */
export function optionsWithCurrent(list: readonly EnumOption[], current: string): EnumOption[] {
  return list.some((o) => o.value === current) ? [...list] : [{ value: current, label: humanizeEnum(current) }, ...list]
}

/** Group `items` by parent id, keeping parents in `parents` order and each group's items in input order. Parents with no items still appear. */
export function groupByParent<P extends { id: string }, T>(parents: readonly P[], items: readonly T[], parentIdOf: (item: T) => string): Array<{ parent: P; items: T[] }> {
  return parents.map((parent) => ({ parent, items: items.filter((item) => parentIdOf(item) === parent.id) }))
}
