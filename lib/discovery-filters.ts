/**
 * Identity of the Solution swimlane board's rendered dataset, for use as its
 * React `key`.
 *
 * `SolutionSwimlaneBoard` seeds its per-lane solution columns from `useState`
 * so drag-and-drop can move cards optimistically, and never re-syncs. Lanes
 * themselves render straight from props, which is what made the original bug
 * hard to see: applying a Solution-level tag filter visibly dropped lanes with
 * nothing left to show, while the lanes that survived went on rendering every
 * one of their untagged solutions.
 *
 * The cause was the key being derived from the *pre-filter* opportunity query
 * rather than from the narrowed set actually handed to the board — so a
 * Solution tag filter, which by design leaves the opportunity rows untouched,
 * never changed it.
 *
 * Deliberately still an id-set signature rather than the filter-input keying
 * the Roadmap and Tasks boards use (lib/board-filter-key.ts): Discovery relies
 * on an unrelated create landing via revalidation to remount and show the new
 * card. Pass the exact array that is rendered and that property holds while the
 * filter case is fixed too.
 */
export function solutionSwimlaneKey(
  opportunities: ReadonlyArray<{ id: string; solutions: ReadonlyArray<{ id: string }> }>
): string {
  return opportunities
    .map((opportunity) => opportunity.id)
    .concat(opportunities.flatMap((opportunity) => opportunity.solutions.map((s) => s.id)))
    .join(",");
}
