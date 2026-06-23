"use client";

import { Badge } from "@/components/ui/badge";
import { OpportunityCard, type OpportunityCardData } from "./opportunity-card";
import type { OpportunityStatus } from "@prisma/client";

const COLUMNS: { status: OpportunityStatus; label: string }[] = [
  { status: "EXPLORING", label: "Exploring" },
  { status: "VALIDATING", label: "Validating" },
  { status: "PRIORITIZED", label: "Prioritized" },
  { status: "ACTIVE", label: "Active" },
];

type Props = {
  opportunitiesByStatus: Record<OpportunityStatus, OpportunityCardData[]>;
  orgSlug: string;
  workspaceSlug: string;
};

export function OpportunityBoard({
  opportunitiesByStatus,
  orgSlug,
  workspaceSlug,
}: Props) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map(({ status, label }) => {
        const cards = opportunitiesByStatus[status] ?? [];
        return (
          <div key={status} className="flex flex-col gap-3 min-w-[300px]">
            <div className="flex items-center gap-2 px-1">
              <span className="text-sm font-medium">{label}</span>
              <Badge variant="secondary" className="text-xs">
                {cards.length}
              </Badge>
            </div>
            <div className="flex flex-col gap-2">
              {cards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 py-8 text-center text-xs text-muted-foreground">
                  No opportunities
                </div>
              ) : (
                cards.map((opp) => (
                  <OpportunityCard
                    key={opp.id}
                    opportunity={opp}
                    orgSlug={orgSlug}
                    workspaceSlug={workspaceSlug}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
