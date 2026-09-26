"use client";

import { useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setActiveScoringModel } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { ScoringEntityType } from "@/lib/types";

const NONE_VALUE = "__none__";

export interface SelectableScoringModel {
  id: string;
  name: string;
  formulaType: string;
}

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  /** Which independent scoring slot this instance of the panel controls. */
  entityType: ScoringEntityType;
  availableModels: SelectableScoringModel[];
  currentScoringModelId: string | null;
}

export function WorkspaceScoringPanel({
  orgSlug,
  workspaceSlug,
  entityType,
  availableModels,
  currentScoringModelId,
}: Props) {
  const [selected, setSelected] = useState(currentScoringModelId ?? NONE_VALUE);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const entityLabel = entityType === "SOLUTION" ? "Solutions" : "Opportunities";

  function handleChange(value: string | null) {
    const next = value ?? NONE_VALUE;
    const previous = selected;
    setSelected(next);
    setError(null);
    startTransition(async () => {
      const result = await setActiveScoringModel(
        orgSlug,
        workspaceSlug,
        entityType,
        next === NONE_VALUE ? null : next
      );
      // The select is updated optimistically above; roll it back rather than
      // leaving the UI claiming a model is active when the write was refused.
      if (!result.ok) {
        setSelected(previous);
        setError(result.error);
      }
    });
  }

  if (availableModels.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No active scoring models available yet. An organization admin can create one in{" "}
        <span className="font-medium">Org Settings → Scoring Models</span>.
      </p>
    );
  }

  // Base UI's <Select.Value> only resolves a value to its label once the
  // matching <Select.Item> has actually mounted in the popup (i.e. after the
  // dropdown has been opened at least once) — without an `items` prop it
  // falls back to rendering the raw value. On a fresh page load (before the
  // user has ever opened this dropdown) that meant the trigger showed the
  // raw scoringModelId UUID instead of the model name. Passing `items`
  // (a value -> label record) lets <Select.Value> resolve the label
  // immediately, with no popup interaction required.
  const items: Record<string, string> = { [NONE_VALUE]: "None" };
  for (const model of availableModels) items[model.id] = model.name;

  return (
    <div className="flex flex-col gap-2">
      <Select value={selected} onValueChange={handleChange} disabled={isPending} items={items}>
        {/* Opportunities keeps its original unqualified label — an existing e2e
            spec (scoring-models.spec.ts) targets it by that exact text, and it
            was the only picker on the page before Solutions was added. */}
        <SelectTrigger
          className="w-full max-w-xs"
          aria-label={entityType === "SOLUTION" ? "Active scoring model for Solutions" : "Active scoring model"}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None</SelectItem>
          {availableModels.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        {entityLabel} in this workspace will show a Scoring {entityType === "SOLUTION" ? "section" : "tab"} using
        the selected model&apos;s metrics.
      </p>
    </div>
  );
}
