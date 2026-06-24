"use client";

import { Badge } from "@/components/ui/badge";
import { OpportunityCard, type OpportunityCardData } from "./opportunity-card";
import { CreateOpportunityForm } from "./create-opportunity-form";
import type { OpportunityStatus, SquadData } from "@/lib/types";

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
  workspaceId: string;
  squads?: SquadData[];
};

export function OpportunityBoard({
  opportunitiesByStatus,
  orgSlug,
  workspaceSlug,
  workspaceId,
  squads = [],
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
              {cards.map((opp) => (
                <OpportunityCard
                  key={opp.id}
                  opportunity={opp}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                />
              ))}
              {cards.length === 0 && (
                <div className="rounded-xl border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
                  No opportunities
                </div>
              )}
            </div>
            <CreateOpportunityForm
              workspaceId={workspaceId}
              defaultStatus={status}
              squads={squads}
            />
          </div>
        );
      })}
    </div>
  );
}
