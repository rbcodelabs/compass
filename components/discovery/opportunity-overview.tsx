"use client";

import { useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateOpportunityStatus, linkOpportunityToKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { SquadPicker } from "@/components/squads/squad-picker";
import { EvidenceList, type EvidenceListItem } from "@/components/discovery/evidence-list";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import type { OpportunityStatus, CustomFieldDefinitionData, CustomFieldValue, SquadData } from "@/lib/types";

const STATUS_LABELS: Record<OpportunityStatus, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

type OpportunityOverviewData = {
  id: string;
  title: string;
  description: string | null;
  customerSegment: string | null;
  status: OpportunityStatus;
  createdAt: Date;
  linkedKeyResult: {
    id: string;
    title: string;
    objective: { title: string };
  } | null;
};

type AvailableKR = {
  id: string;
  title: string;
  objectiveTitle: string;
};

type Props = {
  opportunity: OpportunityOverviewData;
  revalidatePathStr: string;
  availableKeyResults?: AvailableKR[];
  customFields?: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }>;
  squads?: SquadData[];
  currentSquadId?: string | null;
  workspaceId?: string;
  evidence?: EvidenceListItem[];
};

export function OpportunityOverview({
  opportunity,
  revalidatePathStr,
  availableKeyResults = [],
  customFields = [],
  squads = [],
  currentSquadId = null,
  workspaceId,
  evidence,
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
    <div className="flex flex-col gap-5 max-w-xl">
      <Field label="Status">
        <Select
          value={opportunity.status}
          onValueChange={handleStatusChange}
          disabled={isPending}
        >
          <SelectTrigger size="sm" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as OpportunityStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {squads.length > 0 && (
        <Field label="Squad">
          <SquadPicker
            objectType="opportunity"
            objectId={opportunity.id}
            currentSquadId={currentSquadId}
            squads={squads}
            revalidatePathStr={revalidatePathStr}
          />
        </Field>
      )}

      <Separator />

      <Field label="Description">
        {opportunity.description ? (
          <p className="text-sm whitespace-pre-wrap">{opportunity.description}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No description provided.</p>
        )}
      </Field>

      <Field label="Customer Segment">
        {opportunity.customerSegment ? (
          <Badge variant="secondary">{opportunity.customerSegment}</Badge>
        ) : (
          <p className="text-sm text-muted-foreground">Not specified.</p>
        )}
      </Field>

      {/* Key Result link */}
      {availableKeyResults.length > 0 && (
        <Field label="Linked Key Result">
          <Select
            value={opportunity.linkedKeyResult?.id ?? "__none__"}
            onValueChange={handleKRLink}
            disabled={isPending}
          >
            <SelectTrigger size="sm" className="w-64">
              <SelectValue placeholder="Link to a key result…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— None —</SelectItem>
              {availableKeyResults.map((kr) => (
                <SelectItem key={kr.id} value={kr.id}>
                  <span className="text-muted-foreground text-xs mr-1">{kr.objectiveTitle} /</span>
                  {kr.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {opportunity.linkedKeyResult && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {opportunity.linkedKeyResult.objective.title} / {opportunity.linkedKeyResult.title}
            </p>
          )}
        </Field>
      )}

      {/* Custom fields */}
      {customFields.length > 0 && (
        <>
          <Separator />
          <Field label="Custom Fields">
            <CustomFieldsPanel
              fields={customFields}
              objectId={opportunity.id}
              revalidatePathStr={revalidatePathStr}
            />
          </Field>
        </>
      )}

      {/* Evidence */}
      {workspaceId && evidence && (
        <>
          <Separator />
          <Field label={`Evidence${evidence.length > 0 ? ` (${evidence.length})` : ""}`}>
            <div className="flex flex-col gap-2">
              <AddEvidenceDialog
                workspaceId={workspaceId}
                nodeType="opportunity"
                nodeId={opportunity.id}
                revalidatePathStr={revalidatePathStr}
              />
              <EvidenceList evidence={evidence} revalidatePathStr={revalidatePathStr} />
            </div>
          </Field>
        </>
      )}

      <Field label="Created">
        <p className="text-sm text-muted-foreground">
          {opportunity.createdAt.toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </Field>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      {children}
    </div>
  );
}
