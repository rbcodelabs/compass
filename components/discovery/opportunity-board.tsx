"use client";

import { Lightbulb } from "lucide-react";
import { OpportunityCard, type OpportunityCardData } from "./opportunity-card";
import { CreateOpportunityForm } from "./create-opportunity-form";
import type { OpportunityStatus, SquadData } from "@/lib/types";

const COLUMNS: { status: OpportunityStatus; label: string; color: string }[] = [
  { status: "EXPLORING", label: "Exploring", color: "bg-violet-500" },
  { status: "VALIDATING", label: "Validating", color: "bg-amber-500" },
  { status: "PRIORITIZED", label: "Prioritized", color: "bg-blue-500" },
  { status: "ACTIVE", label: "Active", color: "bg-emerald-500" },
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
      {COLUMNS.map(({ status, label, color }) => {
        const cards = opportunitiesByStatus[status] ?? [];
        return (
          <div key={status} className="flex flex-col gap-2 min-w-[280px] w-[280px]">
            {/* Column header */}
            <div className="flex items-center gap-2 px-1 mb-1">
              <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} aria-hidden="true" />
              <span className="text-sm font-semibold text-slate-700">{label}</span>
              <span className="ml-auto text-xs font-medium text-slate-400 bg-slate-200/60 rounded-full px-2 py-0.5 tabular-nums">
                {cards.length}
              </span>
            </div>

            {/* Card well */}
            <div className="flex flex-col gap-2 rounded-xl bg-slate-100/80 p-2.5 min-h-[180px]">
              {cards.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 flex-1 min-h-[120px] rounded-lg border border-dashed border-slate-300/70 py-6">
                  <div className="w-8 h-8 rounded-full bg-slate-200/70 flex items-center justify-center">
                    <Lightbulb className="w-4 h-4 text-slate-400" />
                  </div>
                  <p className="text-xs text-slate-400">No opportunities yet</p>
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

            {/* Add button at bottom of column */}
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
