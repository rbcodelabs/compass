"use client";

import { useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { updateAssumptionStatus } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { AssumptionStatus, RiskLevel } from "@prisma/client";

const RISK_CLASSES: Record<RiskLevel, string> = {
  HIGH: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  MEDIUM: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  LOW: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

const STATUS_LABELS: Record<AssumptionStatus, string> = {
  UNTESTED: "Untested",
  TESTING: "Testing",
  VALIDATED: "Validated",
  INVALIDATED: "Invalidated",
};

const STATUS_CLASSES: Record<AssumptionStatus, string> = {
  UNTESTED: "bg-secondary text-secondary-foreground",
  TESTING: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  VALIDATED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  INVALIDATED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const STATUS_CYCLE: AssumptionStatus[] = [
  "UNTESTED",
  "TESTING",
  "VALIDATED",
  "INVALIDATED",
];

export type AssumptionItemData = {
  id: string;
  title: string;
  riskLevel: RiskLevel;
  status: AssumptionStatus;
  experiments: { id: string }[];
};

type Props = {
  assumption: AssumptionItemData;
  revalidatePathStr: string;
};

export function AssumptionItem({ assumption, revalidatePathStr }: Props) {
  const [isPending, startTransition] = useTransition();
  const currentIndex = STATUS_CYCLE.indexOf(assumption.status);
  const nextStatus = STATUS_CYCLE[(currentIndex + 1) % STATUS_CYCLE.length];

  function advanceStatus() {
    startTransition(async () => {
      await updateAssumptionStatus(assumption.id, nextStatus, revalidatePathStr);
    });
  }

  return (
    <div
      className="flex items-start gap-2 py-1.5 opacity-100 transition-opacity data-[pending]:opacity-50"
      data-pending={isPending ? true : undefined}
    >
      <span className="flex-1 text-sm leading-snug">{assumption.title}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className={`inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium ${RISK_CLASSES[assumption.riskLevel]}`}
        >
          {assumption.riskLevel}
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={isPending}
          onClick={advanceStatus}
          className={`h-5 px-2 text-xs font-medium rounded-4xl border-0 ${STATUS_CLASSES[assumption.status]}`}
          title={`Advance to ${STATUS_LABELS[nextStatus]}`}
        >
          {STATUS_LABELS[assumption.status]}
        </Button>
      </div>
    </div>
  );
}
