"use client";

import * as React from "react";
import { useState, useTransition, useRef } from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { GripVertical } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DndContext,
  type DragEndEvent,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EvidenceBadge } from "@/components/discovery/evidence-badge";
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
  archiveSolution,
  reorderAssumption,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { CardMenu } from "@/components/ui/card-menu";
import { promoteToRoadmap } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { AssumptionItem, type AssumptionItemData } from "./assumption-item";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import type { SolutionStatus, RiskLevel, Horizon } from "@/lib/types";

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
  sortOrder: number;
  assumptions: AssumptionItemData[];
  _count?: { evidence: number };
};

type Props = {
  solution: SolutionCardData;
  revalidatePathStr: string;
  workspaceId: string;
  opportunityId: string;
  squadId: string | null;
};

export function SolutionCard({ solution, revalidatePathStr, workspaceId, opportunityId, squadId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [addingAssumption, setAddingAssumption] = useState(false);
  const [promotingToRoadmap, setPromotingToRoadmap] = useState(false);
  const [horizon, setHorizon] = useState<Horizon>("NOW");
  const [isPending, startTransition] = useTransition();
  const [assumptionRisk, setAssumptionRisk] = useState<RiskLevel>("MEDIUM");
  const [assumptions, setAssumptions] = useState(solution.assumptions);
  const assumptionInputRef = useRef<HTMLInputElement>(null);

  // ─── Outer useSortable (for solutions list) ───────────────────────────────────
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: solution.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // ─── Inner DnD for assumptions ────────────────────────────────────────────────
  const [, startAssumptionTransition] = useTransition();

  const assumptionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleAssumptionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const oldIndex = assumptions.findIndex((a) => a.id === activeId);
    const newIndex = assumptions.findIndex((a) => a.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove(assumptions, oldIndex, newIndex);
      setAssumptions(reordered);

      startAssumptionTransition(async () => {
        await reorderAssumption(activeId, newIndex, revalidatePathStr);
      });
    }
  }

  const assumptionIds = assumptions.map((a) => a.id);

  // ─── Handlers ─────────────────────────────────────────────────────────────────

  const canPromote =
    solution.status === "VALIDATED" || solution.status === "IN_DELIVERY";

  function handlePromote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      await promoteToRoadmap(solution.id, workspaceId, horizon, squadId, opportunityId);
      setPromotingToRoadmap(false);
    });
  }

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

  function handleKill() {
    startTransition(async () => {
      await archiveSolution(solution.id, revalidatePathStr);
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <Card size="sm">
        <CardHeader>
          <div className="flex items-start gap-2 flex-wrap">
            {/* Drag handle */}
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              aria-label="Drag to reorder"
            >
              <GripVertical className="size-3.5" />
            </button>

            {/* Expand toggle */}
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

            <div className="flex-1 min-w-[8rem]">
              <CardTitle className="leading-snug">{solution.title}</CardTitle>
              {solution.description && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                  {solution.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
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
              <EvidenceBadge count={solution._count?.evidence ?? 0} className="shrink-0" />
            </div>
            <CardMenu
              items={[
                {
                  label: "Kill / Archive",
                  onClick: () => handleKill(),
                  destructive: true,
                },
              ]}
            />
          </div>
        </CardHeader>

        {expanded && (
          <CardContent>
            <Separator className="mb-3" />

            {/* Assumptions list with inner DnD */}
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Assumptions
              </p>
              {assumptions.length === 0 && !addingAssumption && (
                <p className="text-xs text-muted-foreground py-1">
                  No assumptions yet.
                </p>
              )}

              <DndContext
                sensors={assumptionSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleAssumptionDragEnd}
              >
                <SortableContext items={assumptionIds} strategy={verticalListSortingStrategy}>
                  {assumptions.map((a) => (
                    <AssumptionItem
                      key={a.id}
                      assumption={a}
                      revalidatePathStr={revalidatePathStr}
                      workspaceId={workspaceId}
                    />
                  ))}
                </SortableContext>
              </DndContext>
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

            <div className="mt-2">
              <AddEvidenceDialog
                workspaceId={workspaceId}
                nodeType="solution"
                nodeId={solution.id}
                revalidatePathStr={revalidatePathStr}
              />
            </div>

            {canPromote && (
              promotingToRoadmap ? (
                <form
                  onSubmit={handlePromote}
                  className="flex items-center gap-2 mt-2 pt-2 border-t border-border"
                >
                  <Select
                    value={horizon}
                    onValueChange={(v: string | null) => { if (v) setHorizon(v as Horizon); }}
                    disabled={isPending}
                  >
                    <SelectTrigger size="sm" className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NOW">Now</SelectItem>
                      <SelectItem value="NEXT">Next</SelectItem>
                      <SelectItem value="LATER">Later</SelectItem>
                      <SelectItem value="SHIPPED">Shipped</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button type="submit" size="sm" disabled={isPending}>
                    {isPending ? "Adding..." : "→ Roadmap"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() => setPromotingToRoadmap(false)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  className="mt-2 text-muted-foreground"
                  onClick={() => setPromotingToRoadmap(true)}
                >
                  → Promote to Roadmap
                </Button>
              )
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
