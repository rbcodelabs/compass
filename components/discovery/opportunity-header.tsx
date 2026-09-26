"use client";

import { useState, useTransition } from "react";
import { TrendingUp } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { SquadPicker } from "@/components/squads/squad-picker";
import { keyResultComboboxItems } from "@/components/discovery/key-result-options";
import {
  updateOpportunityStatus,
  linkOpportunityToKeyResult,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus, SquadData } from "@/lib/types";
import { MarkdownContent } from "@/components/markdown-content";
import { usePanelContext } from "@/components/panels/panel-context";
import { EditableText, patchEntityField, type EditContext } from "@/components/panels/panel-parts";

const STATUS_LABELS: Record<OpportunityStatus, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

const STATUS_BADGE_CLASSES: Record<OpportunityStatus, string> = {
  EXPLORING: "bg-violet-100 text-violet-700 border-violet-200",
  VALIDATING: "bg-amber-100 text-amber-700 border-amber-200",
  PRIORITIZED: "bg-blue-100 text-blue-700 border-blue-200",
  ACTIVE:
    "bg-green-100 text-green-700 border-green-200",
  ARCHIVED: "bg-surface-inset text-text-subtle border-border-default",
};

type KR = {
  id: string;
  title: string;
  objective: { title: string };
  current?: number;
  target?: number;
  unit?: string | null;
};

type AvailableKR = {
  id: string;
  title: string;
  objectiveTitle: string;
};

type Props = {
  opportunity: {
    id: string;
    title: string;
    description: string | null;
    customerSegment: string | null;
    status: OpportunityStatus;
    squadId: string | null;
    linkedKeyResult: KR | null;
  };
  availableKeyResults: AvailableKR[];
  squads: SquadData[];
  revalidatePathStr: string;
  edit?: EditContext;
  onChanged?: () => void;
};

export function OpportunityHeader({
  opportunity,
  availableKeyResults,
  squads,
  revalidatePathStr,
  edit,
  onChanged,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { openPanel } = usePanelContext();

  async function saveField(field: string, value: string | null) {
    if (!edit) return;
    const result = await patchEntityField(edit.type, edit.id, edit.orgSlug, edit.workspaceSlug, field, value);
    edit.onSaved(result.data);
  }

  function handleStatusChange(value: string | null) {
    if (!value) return;
    startTransition(async () => {
      setError(null);
      try {
        if (edit) { await saveField("status", value); return; }
        await updateOpportunityStatus(opportunity.id, value as OpportunityStatus, revalidatePathStr);
        onChanged?.();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not update status."); }
    });
  }

  function handleKRLink(value: string | null) {
    startTransition(async () => {
      setError(null);
      try {
        if (edit) { await saveField("linkedKeyResultId", value === "__none__" ? null : value); return; }
        await linkOpportunityToKeyResult(opportunity.id, value === "__none__" ? null : value, revalidatePathStr);
        onChanged?.();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not link key result."); }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Status + meta row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status badge-select */}
        <Select
          value={opportunity.status}
          onValueChange={handleStatusChange}
          disabled={isPending}
        >
          <SelectTrigger
            size="sm"
            className={`w-auto h-6 rounded-full border px-2.5 py-0 text-xs font-medium shadow-none focus-visible:ring-0 [&_svg]:size-3 [&_svg]:opacity-60 ${STATUS_BADGE_CLASSES[opportunity.status]}`}
          >
            {STATUS_LABELS[opportunity.status]}
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as OpportunityStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Customer segment pill */}
        {opportunity.customerSegment && (
          <span className="inline-flex items-center rounded-full bg-surface-inset text-text-secondary px-2.5 py-0.5 text-xs font-medium border border-border-default">
            {opportunity.customerSegment}
          </span>
        )}

        {/* Squad picker */}
        {squads.length > 0 && (
          <SquadPicker
            objectType="opportunity"
            objectId={opportunity.id}
            currentSquadId={opportunity.squadId}
            squads={squads}
            revalidatePathStr={revalidatePathStr}
            onChanged={onChanged}
            onAssign={edit ? (value) => saveField("squadId", value) : undefined}
          />
        )}
      </div>

      {/* Title */}
      <h1 className="text-2xl font-bold tracking-tight text-text-primary leading-tight">
        {edit ? <EditableText value={opportunity.title} field="title" edit={edit} className="w-full" /> : opportunity.title}
      </h1>

      {/* Description */}
      {edit ? (
        <EditableText value={opportunity.description} field="description" edit={edit} multiline placeholder="Add a description…" className="text-muted-foreground max-w-3xl" />
      ) : opportunity.description ? (
        <MarkdownContent className="text-muted-foreground max-w-2xl">{opportunity.description}</MarkdownContent>
      ) : (
        <p className="text-sm text-muted-foreground/50 italic">
          No description yet.
        </p>
      )}

      {/* KR row */}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-default bg-surface-inset p-3">
        <p className="w-full text-xs font-medium text-text-subtle">Driving Key Result</p>
        {opportunity.linkedKeyResult ? (
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <TrendingUp className="size-3.5 shrink-0 text-indigo-500" />
            <span className="text-xs text-muted-foreground">
              {opportunity.linkedKeyResult.objective.title}
            </span>
            <span className="text-xs text-muted-foreground">/</span>
            <button
              type="button"
              onClick={() => openPanel("keyResult", opportunity.linkedKeyResult!.id)}
              className="text-left text-xs font-medium text-foreground underline underline-offset-2 rounded-sm focus-visible:outline-2 focus-visible:outline-ring break-words"
            >
              {opportunity.linkedKeyResult.title}
            </button>
          </div>
        ) : <p className="text-xs text-muted-foreground">No key result linked.</p>}

        {availableKeyResults.length > 0 && (
          <Combobox
            items={keyResultComboboxItems(availableKeyResults)}
            value={opportunity.linkedKeyResult?.id ?? "__none__"}
            onValueChange={handleKRLink}
            disabled={isPending}
          >
            <ComboboxTrigger size="sm" variant="inline">
              <span className="underline underline-offset-2 decoration-dashed">
                {opportunity.linkedKeyResult ? "change KR" : "Link to key result"}
              </span>
            </ComboboxTrigger>
            <ComboboxContent />
          </Combobox>
        )}
        {opportunity.linkedKeyResult?.current !== undefined && opportunity.linkedKeyResult.target !== undefined && (
          <div className="flex w-full items-center gap-2">
            {opportunity.linkedKeyResult.target > 0 && <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, opportunity.linkedKeyResult.current / opportunity.linkedKeyResult.target * 100))}%` }} /></div>}
            <span className="shrink-0 text-xs tabular-nums text-text-subtle">{opportunity.linkedKeyResult.current}/{opportunity.linkedKeyResult.target}{opportunity.linkedKeyResult.unit ? ` ${opportunity.linkedKeyResult.unit}` : ""}</span>
          </div>
        )}
      </div>
    </div>
  );
}
