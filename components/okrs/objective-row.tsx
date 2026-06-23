"use client";

import { useTransition } from "react";
import { ObjectiveStatus } from "@prisma/client";
import { KeyResultBar } from "@/components/okrs/key-result-bar";
import { AddKeyResultDialog } from "@/components/okrs/add-key-result-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateObjectiveStatus } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

interface KeyResult {
  id: string;
  title: string;
  current: number;
  target: number;
  unit: string | null;
}

interface ObjectiveRowProps {
  objective: {
    id: string;
    title: string;
    status: ObjectiveStatus;
    owner: string | null;
    keyResults: KeyResult[];
  };
  orgSlug: string;
  workspaceSlug: string;
}

const STATUS_BADGE: Record<
  ObjectiveStatus,
  { label: string; className: string }
> = {
  ON_TRACK: {
    label: "On track",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  AT_RISK: {
    label: "At risk",
    className:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
  OFF_TRACK: {
    label: "Off track",
    className:
      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
  COMPLETE: {
    label: "Complete",
    className:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  },
};

function averageProgress(keyResults: KeyResult[]): number {
  if (keyResults.length === 0) return 0;
  const total = keyResults.reduce((sum, kr) => {
    if (kr.target === 0) return sum;
    return sum + Math.min(100, Math.max(0, (kr.current / kr.target) * 100));
  }, 0);
  return Math.round(total / keyResults.length);
}

export function ObjectiveRow({
  objective,
  orgSlug,
  workspaceSlug,
}: ObjectiveRowProps) {
  const [isPending, startTransition] = useTransition();
  const avgProgress = averageProgress(objective.keyResults);
  const badge = STATUS_BADGE[objective.status];

  function handleStatusChange(value: string | null) {
    if (!value) return;
    startTransition(async () => {
      await updateObjectiveStatus(
        objective.id,
        value as ObjectiveStatus,
        orgSlug,
        workspaceSlug
      );
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      {/* Objective header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-medium text-base">{objective.title}</h3>
          {objective.owner && (
            <p className="text-xs text-muted-foreground">{objective.owner}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Overall progress */}
          {objective.keyResults.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {avgProgress}%
            </span>
          )}

          {/* Status select */}
          <Select
            value={objective.status}
            onValueChange={handleStatusChange}
            disabled={isPending}
          >
            <SelectTrigger size="sm" className={badge.className}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.keys(STATUS_BADGE) as ObjectiveStatus[]
              ).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_BADGE[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Overall progress bar */}
      {objective.keyResults.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary/60 transition-all"
              style={{ width: `${avgProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Key results */}
      {objective.keyResults.length > 0 && (
        <div className="flex flex-col gap-3 pl-2 border-l border-border">
          {objective.keyResults.map((kr) => (
            <KeyResultBar
              key={kr.id}
              keyResult={kr}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          ))}
        </div>
      )}

      {/* Add key result */}
      <div>
        <AddKeyResultDialog
          objectiveId={objective.id}
          objectiveTitle={objective.title}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </div>
  );
}
