"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  promoteToRoadmap,
  promoteFeedbackToRoadmap,
} from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { UnscheduledItem } from "./unscheduled-items-panel";
import { HORIZON_META, QUICK_ADD_HORIZONS } from "@/lib/roadmap";
import type { Horizon } from "@/lib/types";

const HORIZON_LABELS: Record<Horizon, string> = Object.fromEntries(
  Object.entries(HORIZON_META).map(([h, m]) => [h, m.label])
) as Record<Horizon, string>;
const HORIZON_OPTIONS: Horizon[] = QUICK_ADD_HORIZONS;

function todayDateInputValue(): string {
  return toDateInputValue(new Date());
}

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Default the end date two weeks out from whatever start date is currently
// entered, purely as a friendly starting point — both fields stay editable.
function addDays(dateInputValue: string, days: number): string {
  const [y, m, d] = dateInputValue.split("-").map(Number);
  return toDateInputValue(new Date(y, m - 1, d + days));
}

type Props = {
  item: UnscheduledItem | null;
  workspaceId: string;
  revalidatePathStr: string;
  onOpenChange: (open: boolean) => void;
  onScheduled: () => void;
};

// Opened when an unscheduled item (Solution or Bug) is dropped onto the
// Timeline. Unlike EditItemDialog, this *creates* the RoadmapItem via the
// same promote actions the Board's drag-and-drop and quick-add menu use —
// the Gantt library has no concept of "drop position -> date" (that's not
// part of its API), so dates are set explicitly here instead.
export function ScheduleItemDialog({ item, workspaceId, onOpenChange, onScheduled }: Props) {
  const [horizon, setHorizon] = useState<Horizon>("NOW");
  const [startDate, setStartDate] = useState(todayDateInputValue());
  const [endDate, setEndDate] = useState(addDays(todayDateInputValue(), 14));
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (item) {
      setHorizon("NOW");
      const today = todayDateInputValue();
      setStartDate(today);
      setEndDate(addDays(today, 14));
    }
  }, [item]);

  if (!item) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!item) return;

    const dates = {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    };

    startTransition(async () => {
      if (item.kind === "solution") {
        await promoteToRoadmap(item.id, workspaceId, horizon, item.squadId, item.opportunityId, dates);
      } else {
        await promoteFeedbackToRoadmap(item.id, workspaceId, horizon, dates);
      }
      onScheduled();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Schedule on the roadmap</DialogTitle>
          </DialogHeader>

          <p className="text-sm text-muted-foreground -mt-1">{item.title}</p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-horizon">Horizon</Label>
            <Select value={horizon} onValueChange={(v) => setHorizon(v as Horizon)} disabled={isPending}>
              <SelectTrigger id="schedule-horizon" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HORIZON_OPTIONS.map((h) => (
                  <SelectItem key={h} value={h}>
                    {HORIZON_LABELS[h]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="schedule-start-date">Start date</Label>
              <Input
                id="schedule-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="flex flex-col gap-1.5 flex-1">
              <Label htmlFor="schedule-end-date">End date</Label>
              <Input
                id="schedule-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Scheduling..." : "Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
