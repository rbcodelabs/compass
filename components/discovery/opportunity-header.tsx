"use client";

import { useTransition } from "react";
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
import {
  updateOpportunityStatus,
  linkOpportunityToKeyResult,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus, SquadData } from "@/lib/types";

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
  ARCHIVED: "bg-slate-100 text-slate-500 border-slate-200",
};

type KR = {
  id: string;
  title: string;
  objective: { title: string };
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
};

export function OpportunityHeader({
  opportunity,
  availableKeyResults,
  squads,
  revalidatePathStr,
}: Props) {
  const [isPending, startTransition] = useTransition();

  function handleStatusChange(value: string | null) {
    if (!value) return;
    startTransition(async () => {
      await updateOpportunityStatus(
        opportunity.id,
        value as OpportunityStatus,
        revalidatePathStr
      );
    });
  }

  function handleKRLink(value: string | null) {
    startTransition(async () => {
      await linkOpportunityToKeyResult(
        opportunity.id,
        value === "__none__" ? null : value,
        revalidatePathStr
      );
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
          <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-600 px-2.5 py-0.5 text-xs font-medium border border-slate-200">
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
          />
        )}
      </div>

      {/* Title */}
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 leading-tight">
        {opportunity.title}
      </h1>

      {/* Description */}
      {opportunity.description ? (
        <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
          {opportunity.description}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground/50 italic">
          No description yet.
        </p>
      )}

      {/* KR row */}
      <div className="flex items-center gap-2 min-h-[20px]">
        {opportunity.linkedKeyResult ? (
          <div className="flex items-center gap-1.5">
            <TrendingUp className="size-3.5 shrink-0 text-indigo-500" />
            <span className="text-xs text-muted-foreground">
              {opportunity.linkedKeyResult.objective.title}
            </span>
            <span className="text-xs text-muted-foreground">/</span>
            <span className="text-xs font-medium text-foreground">
              {opportunity.linkedKeyResult.title}
            </span>
          </div>
        ) : null}

        {availableKeyResults.length > 0 && (
          <Combobox
            items={[
              { value: "__none__", label: "— None —" },
              ...availableKeyResults.map((kr) => ({
                value: kr.id,
                label: kr.title,
                render: (
                  <>
                    <span className="text-muted-foreground text-xs mr-1">
                      {kr.objectiveTitle} /
                    </span>
                    {kr.title}
                  </>
                ),
              })),
            ]}
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
      </div>
    </div>
  );
}
