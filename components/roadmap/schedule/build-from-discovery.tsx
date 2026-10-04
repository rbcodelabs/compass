"use client";

import { useId, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { matchesBuildPreset, type BuildPreset, type ScheduleCatalog } from "@/lib/roadmap/rail";

type Props = {
  catalog: Pick<ScheduleCatalog, "solutions">;
  scheduledIds: ReadonlySet<string>;
  /** Resolves when the batch was created (or failed). */
  onBuild: (preset: BuildPreset) => Promise<unknown>;
  onAddManually: () => void;
};

/**
 * What an empty roadmap shows. Instead of a blank grid it offers to draft a
 * first pass from Discovery: choose a preset, and Compass creates linked roadmap
 * items at proposed non-overlapping slots (highest score first within a squad).
 */
export function BuildFromDiscovery({ catalog, scheduledIds, onBuild, onAddManually }: Props) {
  const labels = useLabels();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<BuildPreset>("validated");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const unscheduled = useMemo(() => catalog.solutions.filter((solution) => !scheduledIds.has(solution.id)), [catalog, scheduledIds]);
  const presets: Array<{ value: BuildPreset; label: string }> = [
    { value: "validated", label: `All validated ${labels.solution.lowerPlural}` },
    { value: "top-scored", label: "Top scored (70+)" },
    { value: "building", label: "Currently building" },
  ];
  const counts = useMemo(
    () => Object.fromEntries(presets.map((option) => [option.value, unscheduled.filter((solution) => matchesBuildPreset(option.value, solution)).length])) as Record<BuildPreset, number>,
    // presets only varies with labels; counts depend on the data
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unscheduled],
  );
  const validated = counts.validated;
  const opportunityCount = new Set(unscheduled.filter((solution) => matchesBuildPreset("validated", solution)).map((solution) => solution.opportunityId)).size;
  const selectedCount = counts[preset];

  async function create() {
    setBusy(true);
    setFailed(false);
    try {
      await onBuild(preset);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="roadmap-empty-state" className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-12 text-center">
      <div aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-6" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight text-foreground">Your roadmap is empty. Your discovery isn&rsquo;t.</h2>
      <p className="max-w-lg text-sm text-muted-foreground">
        {validated > 0
          ? `${validated} validated ${validated === 1 ? labels.solution.lower : labels.solution.lowerPlural} across ${opportunityCount} ${opportunityCount === 1 ? labels.opportunity.lower : labels.opportunity.lowerPlural} ${validated === 1 ? "is" : "are"} ready to plan. `
          : "Nothing validated is waiting yet. "}
        Drag one from the left, press <kbd className="rounded border bg-muted px-1 font-mono text-xs">/</kbd>, or let Compass draft a first pass.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          Build from discovery
        </Button>
        <Button type="button" variant="outline" onClick={onAddManually}>Add an item manually</Button>
      </div>
      {open ? (
        <div id={panelId} role="group" aria-label="Start with" className="mt-1 flex w-full max-w-md flex-col gap-3 rounded-lg border bg-popover p-3 text-left shadow-sm">
          <h3 className="text-xs font-semibold text-muted-foreground">Start with</h3>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={preset === option.value ? "default" : "outline"}
                aria-pressed={preset === option.value}
                className={cn("h-8 rounded-full px-3 text-xs")}
                onClick={() => setPreset(option.value)}
              >
                {option.label} · {counts[option.value]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Compass proposes dates from score and squad capacity, one {labels.solution.lower} at a time per squad. You can drag anything afterwards.
          </p>
          {failed ? <p role="alert" className="text-xs text-destructive">Could not create the roadmap items. Try again.</p> : null}
          <Button type="button" disabled={busy || selectedCount === 0} onClick={create}>
            {busy ? "Creating…" : `Create ${selectedCount} roadmap ${selectedCount === 1 ? "item" : "items"}`}
          </Button>
        </div>
      ) : null}
      <span className="text-xs text-muted-foreground">Items are linked to their {labels.solution.lowerPlural} and stay in sync.</span>
    </div>
  );
}
