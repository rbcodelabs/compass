"use client";

import { useState, useTransition, useRef } from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addAssumption,
  updateSolutionStatus,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { AssumptionItem, type AssumptionItemData } from "./assumption-item";
import type { SolutionStatus, RiskLevel } from "@prisma/client";

const STATUS_BADGE_CLASSES: Record<SolutionStatus, string> = {
  IDEA: "bg-secondary text-secondary-foreground",
  VALIDATED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  IN_DELIVERY: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  SHIPPED: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  KILLED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const STATUS_LABELS: Record<SolutionStatus, string> = {
  IDEA: "Idea",
  VALIDATED: "Validated",
  IN_DELIVERY: "In Delivery",
  SHIPPED: "Shipped",
  KILLED: "Killed",
};

export type SolutionCardData = {
  id: string;
  title: string;
  description: string | null;
  status: SolutionStatus;
  assumptions: AssumptionItemData[];
};

type Props = {
  solution: SolutionCardData;
  revalidatePathStr: string;
};

export function SolutionCard({ solution, revalidatePathStr }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [addingAssumption, setAddingAssumption] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [assumptionRisk, setAssumptionRisk] = useState<RiskLevel>("MEDIUM");
  const assumptionInputRef = useRef<HTMLInputElement>(null);

  function handleStatusChange(value: string | null) {
    if (!value) return;
    startTransition(async () => {
      await updateSolutionStatus(
        solution.id,
        value as SolutionStatus,
        revalidatePathStr
      );
    });
  }

  function handleAddAssumption(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("assumptionTitle") as string).trim();
    if (!title) return;

    startTransition(async () => {
      await addAssumption(
        solution.id,
        { title, riskLevel: assumptionRisk },
        revalidatePathStr
      );
      form.reset();
      setAssumptionRisk("MEDIUM");
      setAddingAssumption(false);
    });
  }

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start gap-2">
          <button
            type="button"
            className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
          </button>
          <div className="flex-1 min-w-0">
            <CardTitle className="leading-snug">{solution.title}</CardTitle>
            {solution.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {solution.description}
              </p>
            )}
          </div>
          <Select
            value={solution.status}
            onValueChange={handleStatusChange}
            disabled={isPending}
          >
            <SelectTrigger size="sm" className="w-auto shrink-0">
              <span
                className={`inline-flex h-4 items-center rounded px-1.5 text-xs font-medium ${STATUS_BADGE_CLASSES[solution.status]}`}
              >
                {STATUS_LABELS[solution.status]}
              </span>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(STATUS_LABELS) as SolutionStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent>
          <Separator className="mb-3" />
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Assumptions
            </p>
            {solution.assumptions.length === 0 && !addingAssumption && (
              <p className="text-xs text-muted-foreground py-1">
                No assumptions yet.
              </p>
            )}
            {solution.assumptions.map((a) => (
              <AssumptionItem
                key={a.id}
                assumption={a}
                revalidatePathStr={revalidatePathStr}
              />
            ))}
          </div>

          {addingAssumption ? (
            <form
              onSubmit={handleAddAssumption}
              className="flex flex-col gap-2 mt-3"
            >
              <Input
                ref={assumptionInputRef}
                name="assumptionTitle"
                placeholder="Assumption title"
                autoFocus
                required
                disabled={isPending}
                className="h-7 text-xs"
              />
              <div className="flex items-center gap-2">
                <Select
                  value={assumptionRisk}
                  onValueChange={(v: string | null) => { if (v) setAssumptionRisk(v as RiskLevel) }}
                  disabled={isPending}
                >
                  <SelectTrigger size="sm" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HIGH">High risk</SelectItem>
                    <SelectItem value="MEDIUM">Medium risk</SelectItem>
                    <SelectItem value="LOW">Low risk</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="submit" size="sm" disabled={isPending}>
                  {isPending ? "Adding..." : "Add"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => setAddingAssumption(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              className="mt-2 text-muted-foreground"
              onClick={() => {
                setAddingAssumption(true);
              }}
            >
              <PlusIcon />
              Add Assumption
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}
