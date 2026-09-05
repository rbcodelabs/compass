"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import type { ExperimentStatus, Conclusion } from "@/lib/types";

export type ExperimentRef = {
  id: string;
  title: string;
  status: string;
  conclusion: string | null;
  hypothesis: string;
  startDate: Date | null;
  endDate: Date | null;
  assumptionTitle: string;
};

type Props = {
  experiments: ExperimentRef[];
  orgSlug: string;
  workspaceSlug: string;
};

const STATUS_BADGE_CLASSES: Record<ExperimentStatus, string> = {
  DESIGNING: "bg-surface-inset text-text-secondary dark:bg-slate-800 dark:text-slate-300",
  RUNNING: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  COMPLETE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  KILLED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const STATUS_LABELS: Record<ExperimentStatus, string> = {
  DESIGNING: "Designing",
  RUNNING: "Running",
  COMPLETE: "Complete",
  KILLED: "Killed",
};

const CONCLUSION_BADGE_CLASSES: Record<Conclusion, string> = {
  PROCEED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  KILL: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  ITERATE: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
};

const CONCLUSION_LABELS: Record<Conclusion, string> = {
  PROCEED: "Proceed",
  KILL: "Kill",
  ITERATE: "Iterate",
};

export function OpportunityExperimentsTab({
  experiments,
  orgSlug,
  workspaceSlug,
}: Props) {
  if (experiments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No experiments yet. Add assumptions to solutions and link experiments to them.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {experiments.map((exp) => {
        const status = exp.status as ExperimentStatus;
        const conclusion = exp.conclusion as Conclusion | null;

        return (
          <Card key={exp.id} size="sm">
            <CardContent className="py-3 px-4">
              <div className="flex items-start gap-2">
                <span
                  className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium shrink-0 mt-0.5 ${STATUS_BADGE_CLASSES[status]}`}
                >
                  {STATUS_LABELS[status]}
                </span>
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/${orgSlug}/${workspaceSlug}/experiments/${exp.id}`}
                    className="text-sm font-medium hover:underline leading-snug"
                  >
                    {exp.title}
                  </Link>
                  <p className="text-xs text-muted-foreground italic mt-0.5">
                    Testing: {exp.assumptionTitle}
                  </p>
                </div>
                {conclusion && (
                  <span
                    className={`inline-flex h-5 items-center rounded px-1.5 text-xs font-medium shrink-0 mt-0.5 ${CONCLUSION_BADGE_CLASSES[conclusion]}`}
                  >
                    {CONCLUSION_LABELS[conclusion]}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
