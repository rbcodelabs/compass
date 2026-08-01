"use client";

import * as React from "react";
import { useState, useTransition, useRef } from "react";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, CheckIcon, XIcon } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
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
  addSolutionComment,
  approveSolutionPlan,
  rejectSolutionPlan,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import { CardMenu } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import { promoteToRoadmap } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { AssumptionItem, type AssumptionItemData } from "./assumption-item";
import { AddEvidenceDialog } from "@/components/discovery/add-evidence-dialog";
import type {
  SolutionStatus,
  RiskLevel,
  Horizon,
  SolutionComment,
  CommentType,
  PlanStatus,
} from "@/lib/types";

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
  comments: SolutionComment[];
  _count?: { evidence: number };
};

const COMMENT_TYPE_LABELS: Record<CommentType, string> = {
  PLAN: "Plan",
  COMMENT: "Comment",
};

const COMMENT_TYPE_BADGE_CLASSES: Record<CommentType, string> = {
  PLAN: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  COMMENT: "bg-secondary text-secondary-foreground",
};

const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const PLAN_STATUS_BADGE_CLASSES: Record<PlanStatus, string> = {
  PENDING: "bg-secondary text-secondary-foreground",
  APPROVED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function formatCommentTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Props = {
  solution: SolutionCardData;
  revalidatePathStr: string;
  workspaceId: string;
  opportunityId: string;
  squadId: string | null;
};

export function SolutionCard({ solution, revalidatePathStr, workspaceId, opportunityId, squadId }: Props) {
  const { openPanel } = usePanelContext();
  const [expanded, setExpanded] = useState(false);
  const [addingAssumption, setAddingAssumption] = useState(false);
  const [promotingToRoadmap, setPromotingToRoadmap] = useState(false);
  const [horizon, setHorizon] = useState<Horizon>("NOW");
  const [isPending, startTransition] = useTransition();
  const [assumptionRisk, setAssumptionRisk] = useState<RiskLevel>("MEDIUM");
  const [assumptions, setAssumptions] = useState(solution.assumptions);
  const assumptionInputRef = useRef<HTMLInputElement>(null);
  const [addingComment, setAddingComment] = useState(false);
  const [commentType, setCommentType] = useState<CommentType>("COMMENT");
  const [isCommentPending, startCommentTransition] = useTransition();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const [isPlanStatusPending, startPlanStatusTransition] = useTransition();
  // Local optimistic copy of the comment thread. revalidatePath alone isn't
  // reliably reflected in-place in Next dev mode (same reason `assumptions`
  // above is client state rather than reading solution.assumptions directly)
  // so we append the server action's returned row ourselves.
  const [comments, setComments] = useState(solution.comments);

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

  // Most recent PLAN entry is the pinned "current plan" — a later
  // add_solution_plan call supersedes any earlier one (see discovery/actions.ts).
  const currentPlan = [...comments].reverse().find((c) => c.commentType === "PLAN");

  function handleAddComment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const body = (data.get("commentBody") as string).trim();
    if (!body) return;

    startCommentTransition(async () => {
      const created = await addSolutionComment(
        solution.id,
        { body, commentType },
        revalidatePathStr
      );
      setComments((prev) => [
        ...prev,
        {
          ...created,
          commentType: created.commentType as CommentType,
          authorType: created.authorType as SolutionComment["authorType"],
          source: created.source as SolutionComment["source"],
          planStatus: created.planStatus as PlanStatus,
          createdAt: new Date(created.createdAt).toISOString(),
          updatedAt: new Date(created.updatedAt).toISOString(),
        },
      ]);
      form.reset();
      setCommentType("COMMENT");
      setAddingComment(false);
    });
  }

  // Approving/rejecting only ever targets the pinned plan — buttons live on
  // the Current Plan box, so there's always a concrete plan id to act on.
  function handlePlanDecision(planId: string, status: "APPROVED" | "REJECTED") {
    startPlanStatusTransition(async () => {
      if (status === "APPROVED") {
        await approveSolutionPlan(planId, revalidatePathStr);
      } else {
        await rejectSolutionPlan(planId, revalidatePathStr);
      }
      setComments((prev) =>
        prev.map((c) => (c.id === planId ? { ...c, planStatus: status } : c))
      );
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
              <CardTitle className="leading-snug">
                <button
                  type="button"
                  onClick={() => openPanel("solution", solution.id)}
                  className="text-left hover:underline underline-offset-2"
                >
                  {solution.title}
                </button>
              </CardTitle>
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

            {/* Plan & Discussion */}
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">
                Plan &amp; Discussion
                {comments.length > 0 && (
                  <span className="ml-1 text-muted-foreground/60">
                    ({comments.length})
                  </span>
                )}
              </p>

              {currentPlan && (
                <div
                  data-testid="current-plan"
                  className="rounded-md border border-blue-200 dark:border-blue-900/50 bg-blue-50/60 dark:bg-blue-950/20 p-2 mb-2"
                >
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span
                      className={`inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium ${COMMENT_TYPE_BADGE_CLASSES.PLAN}`}
                    >
                      Current Plan
                    </span>
                    <span
                      data-testid="plan-status-badge"
                      className={`inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium ${PLAN_STATUS_BADGE_CLASSES[currentPlan.planStatus]}`}
                    >
                      {PLAN_STATUS_LABELS[currentPlan.planStatus]}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {currentPlan.authorName} · {formatCommentTimestamp(currentPlan.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs whitespace-pre-wrap">{currentPlan.body}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <Button
                      type="button"
                      size="xs"
                      variant={currentPlan.planStatus === "APPROVED" ? "default" : "outline"}
                      disabled={isPlanStatusPending || currentPlan.planStatus === "APPROVED"}
                      onClick={() => handlePlanDecision(currentPlan.id, "APPROVED")}
                    >
                      <CheckIcon />
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant={currentPlan.planStatus === "REJECTED" ? "destructive" : "outline"}
                      disabled={isPlanStatusPending || currentPlan.planStatus === "REJECTED"}
                      onClick={() => handlePlanDecision(currentPlan.id, "REJECTED")}
                    >
                      <XIcon />
                      Reject
                    </Button>
                  </div>
                </div>
              )}

              {comments.length === 0 && !addingComment && (
                <p className="text-xs text-muted-foreground py-1">
                  No plan or comments yet.
                </p>
              )}

              {comments.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
                  {comments.map((c) => (
                    <div
                      key={c.id}
                      className="rounded-md border border-border p-2"
                    >
                      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                        <span
                          className={`inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium ${COMMENT_TYPE_BADGE_CLASSES[c.commentType]}`}
                        >
                          {COMMENT_TYPE_LABELS[c.commentType]}
                        </span>
                        {c.commentType === "PLAN" && c.planStatus !== "PENDING" && (
                          <span
                            className={`inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium ${PLAN_STATUS_BADGE_CLASSES[c.planStatus]}`}
                          >
                            {PLAN_STATUS_LABELS[c.planStatus]}
                          </span>
                        )}
                        <span className="text-[10px] font-medium">{c.authorName}</span>
                        {c.authorType === "AGENT" && (
                          <Badge variant="outline" className="h-4 text-[9px] px-1">
                            agent
                          </Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {formatCommentTimestamp(c.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs whitespace-pre-wrap">{c.body}</p>
                    </div>
                  ))}
                </div>
              )}

              {addingComment ? (
                <form
                  onSubmit={handleAddComment}
                  className="flex flex-col gap-2 mt-2"
                >
                  <Textarea
                    ref={commentInputRef}
                    name="commentBody"
                    placeholder="Write a comment or plan update…"
                    autoFocus
                    required
                    disabled={isCommentPending}
                    className="text-xs min-h-16"
                  />
                  <div className="flex items-center gap-2">
                    <Select
                      value={commentType}
                      onValueChange={(v: string | null) => {
                        if (v) setCommentType(v as CommentType);
                      }}
                      disabled={isCommentPending}
                    >
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="COMMENT">Comment</SelectItem>
                        <SelectItem value="PLAN">Plan update</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button type="submit" size="sm" disabled={isCommentPending}>
                      {isCommentPending ? "Posting..." : "Post"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isCommentPending}
                      onClick={() => setAddingComment(false)}
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
                  onClick={() => setAddingComment(true)}
                >
                  <PlusIcon />
                  Add Comment
                </Button>
              )}
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
