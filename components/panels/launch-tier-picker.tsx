"use client";

/**
 * The "no checklist yet" state of the roadmap-item panel's Launch section: a
 * three-tier picker. Each tier previews the default checklist it will seed.
 * Picking a tier calls setLaunchTier (which auto-seeds/resolves the template,
 * attaches a checklist, and moves the item to LAUNCHING), then refreshes the
 * panel so it re-renders in the checklist state.
 */
import { useState, useTransition } from "react";
import { Rocket } from "lucide-react";
import { DEFAULT_CHECKLIST_TEMPLATES } from "@/lib/launch-defaults";
import { setLaunchTier } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/launch-actions";
import type { LaunchTier } from "@/lib/types";

const TIERS: { tier: LaunchTier; blurb: string }[] = [
  { tier: "TIER_1", blurb: "Major launch — full go-to-market push" },
  { tier: "TIER_2", blurb: "Minor launch — incremental release" },
  { tier: "TIER_3", blurb: "Silent launch — ship quietly" },
];

export function LaunchTierPicker({
  itemId,
  workspaceId,
  revalidatePathStr,
  onDone,
}: {
  itemId: string;
  workspaceId: string;
  revalidatePathStr: string;
  onDone: () => void | Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState<LaunchTier | null>(null);

  function pick(tier: LaunchTier) {
    if (pending) return;
    setChosen(tier);
    startTransition(async () => {
      try {
        await setLaunchTier(itemId, tier, workspaceId, revalidatePathStr);
        await onDone();
      } catch {
        setChosen(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Pick a launch tier to attach a checklist and move this item to Launching.
      </p>
      {TIERS.map(({ tier, blurb }) => {
        const def = DEFAULT_CHECKLIST_TEMPLATES[tier];
        const isChosen = chosen === tier;
        return (
          <button
            key={tier}
            type="button"
            disabled={pending}
            onClick={() => pick(tier)}
            aria-label={`Set launch tier: ${def.name}`}
            className={`text-left rounded-lg border border-border p-3 transition-colors hover:bg-muted/50 disabled:opacity-60 ${
              isChosen ? "ring-2 ring-amber-300" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Rocket className="size-3.5 text-amber-500" />
                {def.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {isChosen && pending ? "Setting…" : `${def.items.length} items`}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{blurb}</p>
            <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-muted-foreground/80">
              {def.items.slice(0, 3).map((it) => (
                <li key={it.label} className="truncate">• {it.label}</li>
              ))}
              {def.items.length > 3 && (
                <li className="text-muted-foreground/60">+{def.items.length - 3} more</li>
              )}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
