"use client";

import Link from "next/link";
import { useTransition } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { updateOpportunityStatus } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus } from "@/lib/types";

const STATUS_ORDER: OpportunityStatus[] = [
  "EXPLORING",
  "VALIDATING",
  "PRIORITIZED",
  "ACTIVE",
];

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
  const currentIndex = STATUS_ORDER.indexOf(opportunity.status);
  const canMoveLeft = currentIndex > 0;
  const canMoveRight = currentIndex < STATUS_ORDER.length - 1;

  const detailPath = `/${orgSlug}/${workspaceSlug}/discovery/${opportunity.id}`;
  const boardPath = `/${orgSlug}/${workspaceSlug}/discovery`;

  function moveStatus(direction: "left" | "right") {
    const nextStatus =
      direction === "left"
        ? STATUS_ORDER[currentIndex - 1]
        : STATUS_ORDER[currentIndex + 1];
    startTransition(async () => {
      await updateOpportunityStatus(opportunity.id, nextStatus, boardPath);
    });
  }

  return (
    <Card
      size="sm"
      className="w-[280px] shrink-0 opacity-100 transition-opacity data-[pending]:opacity-60"
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
        </div>
        {opportunity.customerSegment && (
          <p className="text-xs text-muted-foreground truncate">
            {opportunity.customerSegment}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <Badge variant="secondary">
            {opportunity._count.solutions}{" "}
            {opportunity._count.solutions === 1 ? "solution" : "solutions"}
          </Badge>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!canMoveLeft || isPending}
              onClick={() => moveStatus("left")}
              title="Move left"
            >
              <ChevronLeftIcon />
              <span className="sr-only">Move left</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!canMoveRight || isPending}
              onClick={() => moveStatus("right")}
              title="Move right"
            >
              <ChevronRightIcon />
              <span className="sr-only">Move right</span>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
