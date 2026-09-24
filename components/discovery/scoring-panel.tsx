"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangleIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { computeScore } from "@/lib/scoring";
import { saveOpportunityScore } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { ScoringModelData, OpportunityScoreData } from "@/lib/types";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  opportunityId: string;
  revalidatePathStr: string;
  scoringModel: ScoringModelData;
  existingScore: OpportunityScoreData | null;
  onSaved?: () => void;
}

export function ScoringPanel({
  orgSlug,
  workspaceSlug,
  opportunityId,
  revalidatePathStr,
  scoringModel,
  existingScore,
  onSaved,
}: Props) {
  const [rawValues, setRawValues] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const metric of scoringModel.metrics) {
      initial[metric.key] = existingScore?.rawValues[metric.key] ?? metric.minValue;
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);
  const [savedScore, setSavedScore] = useState<{ rawScore: number; normalizedScore: number } | null>(
    existingScore ? { rawScore: existingScore.rawScore, normalizedScore: existingScore.normalizedScore } : null
  );
  const [isPending, startTransition] = useTransition();

  const metricDefs = useMemo(
    () =>
      scoringModel.metrics.map((m) => ({
        key: m.key,
        minValue: m.minValue,
        maxValue: m.maxValue,
        weight: m.weight,
        direction: m.direction,
      })),
    [scoringModel.metrics]
  );

  const preview = useMemo(
    () => computeScore(metricDefs, rawValues, scoringModel.formulaType),
    [metricDefs, rawValues, scoringModel.formulaType]
  );

  function handleChange(key: string, value: string) {
    const parsed = parseFloat(value);
    setRawValues((prev) => ({ ...prev, [key]: Number.isNaN(parsed) ? 0 : parsed }));
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveOpportunityScore(
          orgSlug,
          workspaceSlug,
          opportunityId,
          rawValues,
          revalidatePathStr
        );
        setSavedScore(result);
        onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save score");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4 max-w-xl">
      <div>
        <p className="text-sm font-medium">{scoringModel.name}</p>
        {scoringModel.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{scoringModel.description}</p>
        )}
      </div>

      {existingScore?.stale && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangleIcon className="size-3.5 shrink-0 mt-0.5" />
          <span>
            This opportunity was scored under an earlier version (v{existingScore.modelVersion}) of
            this model. The score below reflects that earlier formula — re-save to score it under
            the current version (v{scoringModel.version}).
          </span>
        </div>
      )}

      <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
        {scoringModel.metrics.map((metric) => (
          <div key={metric.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex flex-col gap-0.5 min-w-0">
              <Label htmlFor={`metric-${metric.key}`} className="text-sm font-medium">
                {metric.label}
              </Label>
              <span className="text-xs text-muted-foreground">
                {metric.direction === "POSITIVE" ? "Increases" : "Decreases"} score · weight{" "}
                {metric.weight} · range {metric.minValue}–{metric.maxValue}
              </span>
            </div>
            <Input
              id={`metric-${metric.key}`}
              type="number"
              className="w-24 h-8 text-sm shrink-0"
              min={metric.minValue}
              max={metric.maxValue}
              value={rawValues[metric.key] ?? metric.minValue}
              disabled={isPending}
              onChange={(e) => handleChange(metric.key, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-muted/40 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">Live preview</p>
          <p className="text-sm font-medium">
            Raw score: {preview.rawScore.toFixed(2)} · Normalized:{" "}
            {preview.normalizedScore.toFixed(1)} / 100
          </p>
        </div>
        {savedScore && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Last saved</p>
            <p className="text-sm font-medium">{savedScore.normalizedScore.toFixed(1)} / 100</p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div>
        <Button type="button" size="sm" disabled={isPending} onClick={handleSave}>
          {isPending ? "Saving..." : existingScore ? "Update Score" : "Save Score"}
        </Button>
      </div>
    </div>
  );
}
