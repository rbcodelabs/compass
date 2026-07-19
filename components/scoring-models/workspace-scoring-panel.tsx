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

const NONE_VALUE = "__none__";

export interface SelectableScoringModel {
  id: string;
  name: string;
  formulaType: string;
}

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  availableModels: SelectableScoringModel[];
  currentScoringModelId: string | null;
}

export function WorkspaceScoringPanel({
  orgSlug,
  workspaceSlug,
  availableModels,
  currentScoringModelId,
}: Props) {
  const [selected, setSelected] = useState(currentScoringModelId ?? NONE_VALUE);
  const [isPending, startTransition] = useTransition();

  function handleChange(value: string | null) {
    const next = value ?? NONE_VALUE;
    setSelected(next);
    startTransition(async () => {
      await setActiveScoringModel(orgSlug, workspaceSlug, next === NONE_VALUE ? null : next);
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
        <SelectTrigger className="w-full max-w-xs" aria-label="Active scoring model">
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
      <p className="text-xs text-muted-foreground">
        Opportunities in this workspace will show a Scoring tab using the selected model&apos;s
        metrics.
      </p>
    </div>
  );
}
