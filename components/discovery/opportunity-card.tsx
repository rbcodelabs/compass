"use client";

import Link from "next/link";
import { useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CardMenu } from "@/components/ui/card-menu";
import {
  updateOpportunityStatus,
  archiveOpportunity,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus } from "@/lib/types";

const STATUS_ORDER: OpportunityStatus[] = [
  "EXPLORING",
  "VALIDATING",
  "PRIORITIZED",
  "ACTIVE",
];

const STATUS_LABELS: Record<OpportunityStatus, string> = {
  EXPLORING: "Exploring",
  VALIDATING: "Validating",
  PRIORITIZED: "Prioritized",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

export type OpportunityCardData = {
  id: string;
  title: string;
  customerSegment: string | null;
  status: OpportunityStatus;
  _count: { solutions: number };
  squad?: { id: string; name: string; color: string } | null;
};

type Props = {
  opportunity: OpportunityCardData;
  orgSlug: string;
  workspaceSlug: string;
};

export function OpportunityCard({ opportunity, orgSlug, workspaceSlug }: Props) {
  const [isPending, startTransition] = useTransition();

  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunity.id}`;
  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;

  function moveStatus(status: OpportunityStatus) {
    startTransition(async () => {
      await updateOpportunityStatus(opportunity.id, status, boardPath);
    });
  }

  function handleArchive() {
    startTransition(async () => {
      await archiveOpportunity(opportunity.id, boardPath);
    });
  }

  return (
    <Card
      size="sm"
      className="w-full shrink-0 opacity-100 transition-all duration-150 bg-white shadow-sm hover:shadow-md data-[pending]:opacity-60 cursor-pointer group"
      data-pending={isPending ? true : undefined}
    >
      <CardHeader>
        <div className="flex items-start gap-2">
          {opportunity.squad && (
            <span
              className="mt-0.5 w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: opportunity.squad.color }}
              title={opportunity.squad.name}
            />
          )}
          <CardTitle className="flex-1">
            <Link
              href={detailPath}
              className="hover:underline underline-offset-2 line-clamp-2"
            >
              {opportunity.title}
            </Link>
          </CardTitle>
          <CardMenu
            items={[
              ...STATUS_ORDER.filter((s) => s !== opportunity.status).map((s) => ({
                label: `Move to ${STATUS_LABELS[s]}`,
                onClick: () => moveStatus(s),
                disabled: isPending,
              })),
              {
                label: "Archive",
                onClick: () => handleArchive(),
                separator: true,
                destructive: true,
              },
            ]}
          />
        </div>
        {opportunity.customerSegment && (
          <p className="text-xs text-muted-foreground truncate">
            {opportunity.customerSegment}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <Badge variant="secondary">
          {opportunity._count.solutions}{" "}
          {opportunity._count.solutions === 1 ? "solution" : "solutions"}
        </Badge>
      </CardContent>
    </Card>
  );
}
