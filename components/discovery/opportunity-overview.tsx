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
import { updateOpportunityStatus } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus } from "@/lib/types";

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

type Props = {
  opportunity: OpportunityOverviewData;
  revalidatePathStr: string;
};

export function OpportunityOverview({ opportunity, revalidatePathStr }: Props) {
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

      {opportunity.linkedKeyResult && (
        <Field label="Linked Key Result">
          <div className="flex flex-col gap-0.5">
            <p className="text-xs text-muted-foreground">
              {opportunity.linkedKeyResult.objective.title}
            </p>
            <p className="text-sm font-medium">
              {opportunity.linkedKeyResult.title}
            </p>
          </div>
        </Field>
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
