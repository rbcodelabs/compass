"use client";

import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
import { usePanelContext } from "@/components/panels/panel-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OPPORTUNITY_STATUS_BADGE } from "@/lib/discovery";
import { SOLUTION_STATUS } from "@/lib/solution-status";
import type { OpportunityStatus, SolutionStatus } from "@/lib/types";

export type DiscoveryTableSolution = {
  id: string;
  title: string;
  status: SolutionStatus;
  sortOrder: number;
  evidenceCount: number;
  assumptionCount: number;
};

export type DiscoveryTableOpportunity = {
  id: string;
  title: string;
  customerSegment: string | null;
  status: OpportunityStatus;
  sortOrder: number;
  squad: { id: string; name: string; color: string } | null;
  evidenceCount: number;
  solutions: DiscoveryTableSolution[];
};

function StatusBadge({ label, className }: { label: string; className: string }) {
  return <span className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium ${className}`}>{label}</span>;
}

function countLabel(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function DiscoveryTableView({ opportunities }: { opportunities: DiscoveryTableOpportunity[] }) {
  const { openPanel } = usePanelContext();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  function toggleOpportunity(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (opportunities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-default px-4 py-12 text-center text-sm text-text-secondary">
        No opportunities match the current filters.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-default bg-surface-panel">
      <Table aria-label="Discovery opportunities">
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-72">Item</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Squad</TableHead>
            <TableHead>Customer segment</TableHead>
            <TableHead>Evidence</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {opportunities.map((opportunity) => {
            const isExpanded = expandedIds.has(opportunity.id);
            const opportunityStatus = OPPORTUNITY_STATUS_BADGE[opportunity.status];

            return (
              <Fragment key={opportunity.id}>
                <TableRow>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {opportunity.solutions.length > 0 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${opportunity.title}`}
                          aria-expanded={isExpanded}
                          onClick={() => toggleOpportunity(opportunity.id)}
                        >
                          <ChevronRight className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                        </Button>
                      ) : (
                        <span className="size-6" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        onClick={() => openPanel("opportunity", opportunity.id)}
                        className="max-w-md truncate text-left font-medium hover:underline underline-offset-2"
                      >
                        {opportunity.title}
                      </button>
                    </div>
                  </TableCell>
                  <TableCell><StatusBadge {...opportunityStatus} /></TableCell>
                  <TableCell>
                    {opportunity.squad ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2.5 rounded-full" style={{ backgroundColor: opportunity.squad.color }} />
                        {opportunity.squad.name}
                      </span>
                    ) : <span className="text-text-subtle">—</span>}
                  </TableCell>
                  <TableCell>{opportunity.customerSegment ?? <span className="text-text-subtle">—</span>}</TableCell>
                  <TableCell><EvidenceBadge count={opportunity.evidenceCount} /></TableCell>
                  <TableCell><Badge variant="secondary">{countLabel(opportunity.solutions.length, "solution")}</Badge></TableCell>
                </TableRow>

                {isExpanded && opportunity.solutions.map((solution) => (
                  <TableRow key={solution.id} className="bg-surface-inset/50">
                    <TableCell className="pl-12">
                      <button
                        type="button"
                        onClick={() => openPanel("solution", solution.id)}
                        className="max-w-md truncate text-left hover:underline underline-offset-2"
                      >
                        {solution.title}
                      </button>
                    </TableCell>
                    <TableCell><StatusBadge {...SOLUTION_STATUS[solution.status]} /></TableCell>
                    <TableCell className="text-text-subtle">—</TableCell>
                    <TableCell className="text-text-subtle">—</TableCell>
                    <TableCell><EvidenceBadge count={solution.evidenceCount} /></TableCell>
                    <TableCell><Badge variant="secondary">{countLabel(solution.assumptionCount, "assumption")}</Badge></TableCell>
                  </TableRow>
                ))}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
