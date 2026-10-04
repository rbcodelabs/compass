/**
 * Pure view-model helpers for the "Ready to schedule" rail, the schedule
 * palette and the empty-roadmap presets. Client-safe: no I/O.
 */

/** A Discovery solution as the schedule UI sees it. */
export type CatalogSolution = {
  id: string;
  title: string;
  status: string;
  /** Normalized 0-100 score, or null when unscored. */
  score: number | null;
  opportunityId: string;
  opportunityTitle: string;
  squadId: string | null;
};

export type CatalogOpportunity = { id: string; title: string; squadId: string | null };

export type ScheduleCatalog = {
  solutions: CatalogSolution[];
  opportunities: CatalogOpportunity[];
  /** Solutions that already have an ACTIVE roadmap item (regardless of any view filter). */
  scheduledSolutionIds: string[];
};

/** Statuses that make a solution "ready to schedule": validated, or already being built. */
export const READY_STATUSES: readonly string[] = ["VALIDATED", "IN_DELIVERY"];
export const TOP_SCORE_THRESHOLD = 70;

export type RailFilter = "all" | "validated" | "top";
export type BuildPreset = "validated" | "top-scored" | "building";

type Scorable = { status?: string; score?: number | null };

export function matchesRailFilter(item: Scorable, filter: RailFilter): boolean {
  if (filter === "validated") return item.status === "VALIDATED";
  if (filter === "top") return (item.score ?? -1) >= TOP_SCORE_THRESHOLD;
  return true;
}

export function matchesQuery(query: string, ...parts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/** The same predicates the server applies in buildRoadmapFromDiscovery, for the preset counts. */
export function matchesBuildPreset(preset: BuildPreset, item: Scorable): boolean {
  if (preset === "building") return item.status === "IN_DELIVERY";
  if (preset === "validated") return item.status === "VALIDATED";
  return READY_STATUSES.includes(item.status ?? "") && (item.score ?? -1) >= TOP_SCORE_THRESHOLD;
}

export type OpportunityGroup<T> = { opportunityId: string; opportunityTitle: string; items: T[] };

/** Groups solutions under their opportunity, highest score first within each group. */
export function groupByOpportunity<T extends { opportunityId: string; opportunityTitle: string; score?: number | null; title: string }>(
  items: readonly T[],
): OpportunityGroup<T>[] {
  const groups = new Map<string, OpportunityGroup<T>>();
  for (const item of items) {
    const group = groups.get(item.opportunityId) ?? { opportunityId: item.opportunityId, opportunityTitle: item.opportunityTitle, items: [] };
    group.items.push(item);
    groups.set(item.opportunityId, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    items: [...group.items].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.title.localeCompare(b.title)),
  }));
}

export type PaletteRow =
  | { type: "solution"; solution: CatalogSolution; scheduled: boolean }
  | { type: "opportunity"; opportunity: CatalogOpportunity; unscheduled: CatalogSolution[] };

/**
 * Palette results: every solution (unscheduled first, then by score) followed by
 * every opportunity that matches. Already-scheduled solutions stay listed so
 * the user can see them, but are flagged and inert.
 */
export function searchCatalog(catalog: Pick<ScheduleCatalog, "solutions" | "opportunities">, scheduledIds: ReadonlySet<string>, query: string): PaletteRow[] {
  const solutions = catalog.solutions
    .filter((solution) => matchesQuery(query, solution.title, solution.opportunityTitle))
    .map((solution): PaletteRow => ({ type: "solution", solution, scheduled: scheduledIds.has(solution.id) }))
    .sort((a, b) => {
      if (a.type !== "solution" || b.type !== "solution") return 0;
      return Number(a.scheduled) - Number(b.scheduled) || (b.solution.score ?? -1) - (a.solution.score ?? -1) || a.solution.title.localeCompare(b.solution.title);
    });
  const opportunities = catalog.opportunities
    .filter((opportunity) => matchesQuery(query, opportunity.title))
    .map((opportunity): PaletteRow => ({
      type: "opportunity",
      opportunity,
      unscheduled: catalog.solutions.filter((solution) => solution.opportunityId === opportunity.id && !scheduledIds.has(solution.id)),
    }));
  return [...solutions, ...opportunities];
}

/** The solutions a palette row would schedule. Shift+Enter always means "everything under the opportunity". */
export function solutionsToSchedule(row: PaletteRow, catalog: Pick<ScheduleCatalog, "solutions">, scheduledIds: ReadonlySet<string>, all: boolean): CatalogSolution[] {
  const unscheduledUnder = (opportunityId: string) => catalog.solutions.filter((solution) => solution.opportunityId === opportunityId && !scheduledIds.has(solution.id));
  if (row.type === "opportunity") return unscheduledUnder(row.opportunity.id);
  if (all) return unscheduledUnder(row.solution.opportunityId);
  return row.scheduled ? [] : [row.solution];
}
