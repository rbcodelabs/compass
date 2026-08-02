"use client";

/**
 * The "has a checklist" state of the roadmap-item panel's Launch section:
 * tier badge + progress bar + a tri-state Select per item. Each toggle is
 * optimistic and persisted via the updateLaunchChecklistItem server action;
 * on failure the row reverts.
 */
import { useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { updateLaunchChecklistItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/launch-actions";
import { HORIZON_META } from "@/lib/roadmap";
import type { LaunchTier, LaunchChecklistItemStatus } from "@/lib/types";

export type LaunchChecklistItemData = {
  id: string;
  label: string;
  description: string | null;
  status: string;
  order: number;
};

const TIER_LABELS: Record<LaunchTier, string> = {
  TIER_1: "Tier 1 — Major",
  TIER_2: "Tier 2 — Minor",
  TIER_3: "Tier 3 — Silent",
};

const STATUS_OPTIONS: { value: LaunchChecklistItemStatus; label: string }[] = [
  { value: "PENDING", label: "Pending" },
  { value: "DONE", label: "Done" },
  { value: "SKIPPED", label: "Skipped" },
];

const STATUS_TRIGGER_CLASS: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-600",
  DONE: "bg-green-100 text-green-700",
  SKIPPED: "bg-amber-50 text-amber-700",
};

export function LaunchChecklist({
  horizon,
  tier,
  items,
  workspaceId,
  revalidatePathStr,
}: {
  horizon: string;
  tier: string;
  items: LaunchChecklistItemData[];
  workspaceId: string;
  revalidatePathStr: string;
}) {
  // Local optimistic status overlay, keyed by item id.
  const [statuses, setStatuses] = useState<Record<string, string>>(
    () => Object.fromEntries(items.map((i) => [i.id, i.status]))
  );
  const [, startTransition] = useTransition();

  const resolved = items.map((i) => ({ ...i, status: statuses[i.id] ?? i.status }));
  const done = resolved.filter((i) => i.status === "DONE").length;
  const skipped = resolved.filter((i) => i.status === "SKIPPED").length;
  const total = resolved.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  function setStatus(itemId: string, next: LaunchChecklistItemStatus) {
    const prev = statuses[itemId];
    if (prev === next) return;
    setStatuses((s) => ({ ...s, [itemId]: next }));
    startTransition(async () => {
      try {
        await updateLaunchChecklistItem(itemId, next, workspaceId, revalidatePathStr);
      } catch {
        // revert on failure
        setStatuses((s) => ({ ...s, [itemId]: prev }));
      }
    });
  }

  const tierBadge = HORIZON_META[horizon as keyof typeof HORIZON_META]?.badgeClass ?? "bg-amber-100 text-amber-700";

  return (
    <div className="flex flex-col gap-3">
      {/* Tier + progress */}
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tierBadge}`}>
          {TIER_LABELS[tier as LaunchTier] ?? tier}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {done}/{total} done{skipped > 0 ? ` · ${skipped} skipped` : ""}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${pct}%` }} />
      </div>

      {/* Items */}
      <ul className="flex flex-col gap-2">
        {resolved.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span
                className={`text-sm leading-snug ${item.status === "DONE" ? "text-muted-foreground line-through" : "text-foreground/90"}`}
              >
                {item.label}
              </span>
              {item.description && (
                <span className="text-xs text-muted-foreground">{item.description}</span>
              )}
            </div>
            <Select
              value={item.status}
              onValueChange={(v) => v && setStatus(item.id, v as LaunchChecklistItemStatus)}
            >
              <SelectTrigger
                size="sm"
                className={`w-fit shrink-0 border-0 ${STATUS_TRIGGER_CLASS[item.status] ?? ""}`}
              >
                <span className="text-xs font-medium">
                  {STATUS_OPTIONS.find((o) => o.value === item.status)?.label ?? item.status}
                </span>
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </li>
        ))}
      </ul>
    </div>
  );
}
