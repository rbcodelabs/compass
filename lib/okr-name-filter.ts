/**
 * Name matching for the OKR cycle screen's quick filter. Pure so it is unit
 * testable; the UI lives in components/okrs/okr-name-filter.tsx.
 */

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function titleMatches(title: string, query: string): boolean {
  const q = normalizeQuery(query);
  return q === "" || title.toLowerCase().includes(q);
}

/** An objective is shown when it, or any of its key results, matches. */
export function objectiveMatches(
  objective: { title: string; keyResults: ReadonlyArray<{ title: string }> },
  query: string
): boolean {
  if (normalizeQuery(query) === "") return true;
  return titleMatches(objective.title, query) || objective.keyResults.some((kr) => titleMatches(kr.title, query));
}

/**
 * Splits a title around the first match of the query so the UI can mark it.
 * Returns null when there is nothing to mark (empty query or no match).
 */
export function splitMatch(title: string, query: string): { before: string; match: string; after: string } | null {
  const q = normalizeQuery(query);
  if (q === "") return null;
  const lowerTitle = title.toLowerCase();
  const index = lowerTitle.indexOf(q);
  if (index < 0) return null;

  let start = index;
  let end = index + q.length;
  if (lowerTitle.length !== title.length) {
    // Map lowercase offsets back to whole source characters (e.g. İ → i + combining dot).
    let sourceOffset = 0;
    let lowerOffset = 0;
    for (const char of title) {
      const nextLowerOffset = lowerOffset + char.toLowerCase().length;
      if (lowerOffset <= index && index < nextLowerOffset) start = sourceOffset;
      sourceOffset += char.length;
      lowerOffset = nextLowerOffset;
      if (lowerOffset >= index + q.length) {
        end = sourceOffset;
        break;
      }
    }
  }
  return { before: title.slice(0, start), match: title.slice(start, end), after: title.slice(end) };
}
