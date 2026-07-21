import type { OpportunityStatus } from "@/lib/types";

export type ActiveOpportunityStatus = Exclude<OpportunityStatus, "ARCHIVED">;

export const ACTIVE_OPPORTUNITY_STATUS_ORDER: ActiveOpportunityStatus[] = [
  "EXPLORING",
  "VALIDATING",
  "PRIORITIZED",
  "ACTIVE",
];

export type GroupedOpportunities<T> = {
  active: Record<ActiveOpportunityStatus, T[]>;
  archived: T[];
};

export function filterOpportunitiesByTitle<T extends { title: string }>(
  opportunities: T[],
  query: string
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return opportunities;
  return opportunities.filter((o) => o.title.toLowerCase().includes(trimmed));
}

export function groupOpportunitiesByStatus<T extends { status: OpportunityStatus }>(
  opportunities: T[]
): GroupedOpportunities<T> {
  const active = ACTIVE_OPPORTUNITY_STATUS_ORDER.reduce(
    (acc, status) => {
      acc[status] = opportunities.filter((o) => o.status === status);
      return acc;
    },
    {} as Record<ActiveOpportunityStatus, T[]>
  );

  return {
    active,
    archived: opportunities.filter((o) => o.status === "ARCHIVED"),
  };
}
