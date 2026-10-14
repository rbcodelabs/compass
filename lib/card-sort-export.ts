import { toCsv, type CsvCell } from "@/lib/csv"
import type { CardSortTally } from "@/lib/card-sort"

/**
 * Card sort tally → CSV. One row per proposal.
 *
 * Built from a CardSortTally rather than from the database, deliberately: the
 * tally is what getCardSortTally returns *after* assertCanSeeOtherProposals, so
 * the export can only ever contain what the caller was already allowed to see.
 * There is no second read path here that could forget the hidden-until-revealed
 * gate.
 *
 * Like the tally itself this lists proposals that exist and nothing else. It
 * does not emit a row for an object nobody proposed on, because absence of a
 * proposal means "no opinion recorded", not agreement (see lib/card-sort-tally).
 */

const UNSET_LABEL = ""

export function buildCardSortCsv(tally: CardSortTally): string {
  const labelFor = (value: string | null) =>
    value == null ? UNSET_LABEL : (tally.options.find((option) => option.value === value)?.label ?? value)

  const factor = tally.round.factorName
  const header = [
    "Object",
    `Current ${factor}`,
    `Proposed ${factor}`,
    "Proposer",
    "Rationale",
    "Proposals on this object",
    "Different targets proposed",
  ]

  const rows: CsvCell[][] = []
  for (const object of tally.objects) {
    for (const target of object.targets) {
      for (const proposer of target.proposers) {
        rows.push([
          object.title,
          labelFor(object.currentValue),
          labelFor(target.value),
          proposer.userName,
          proposer.rationale,
          object.proposalCount,
          object.distinctTargetCount,
        ])
      }
    }
  }
  return toCsv(header, rows)
}
