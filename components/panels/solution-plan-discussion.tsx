"use client";

import * as React from "react";
import { useRef, useState, useTransition } from "react";
import { CheckIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendToAgentPicker } from "@/components/agent/send-to-agent-picker";
import {
  addSolutionComment,
  approveSolutionPlan,
  rejectSolutionPlan,
} from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { SolutionComment, CommentType, PlanStatus } from "@/lib/types";

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

/**
 * The Solution panel's Plan & Discussion section — moved here verbatim (same
 * data-testids, same behavior) from the expanding discovery/solution-card.tsx
 * so it's reachable from the sidebar, which is the one place every solution
 * is now managed from.
 */
type Props = {
  solutionId: string;
  comments: SolutionComment[];
  revalidatePathStr: string;
  /** Used to build the "Send to agent" hand-off link (`/${orgSlug}/${workspaceSlug}/agent?...`). */
  orgSlug: string;
  workspaceSlug: string;
  /**
   * Notify the panel that the comment set changed. The thread itself renders
   * from local state below, but the enclosing <Section label="Plan & Discussion"
   * count={data.comments.length}> header counts the panel's *fetched* data —
   * without this the count stays stuck at its load-time value while the thread
   * visibly grows.
   */
  onChanged?: () => void;
};

export function SolutionPlanDiscussion({
  solutionId,
  comments: initialComments,
  revalidatePathStr,
  orgSlug,
  workspaceSlug,
  onChanged,
}: Props) {
  // This component owns comment mutations (add/approve/reject all update local
  // state directly below) so a plain useState seeded from props drives the
  // thread. Mutations additionally call onChanged() so the panel refetches and
  // any data derived from its copy of the comments (the section count) follows.
  const [comments, setComments] = useState(
    initialComments.filter((comment) => comment.commentType === "PLAN")
  );

  const [addingComment, setAddingComment] = useState(false);
  const [isCommentPending, startCommentTransition] = useTransition();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const [isPlanStatusPending, startPlanStatusTransition] = useTransition();

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
        solutionId,
        { body, commentType: "PLAN" },
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
      setAddingComment(false);
      onChanged?.();
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
      onChanged?.();
    });
  }

  return (
    <div className="flex flex-col gap-1">
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
            {/* Styled as a button but genuinely a link (or, inside Geode, a
                menu trigger) — see SendToAgentPicker's own doc comment for
                why it isn't routed through Base UI's Button. */}
            {currentPlan.planStatus === "APPROVED" && (
              <SendToAgentPicker
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                entityType="solutionPlan"
                entityId={currentPlan.id}
                className={buttonVariants({ size: "xs", variant: "outline" })}
              >
                <SparklesIcon />
                Send to agent
              </SendToAgentPicker>
            )}
          </div>
        </div>
      )}

      {comments.length === 0 && !addingComment && (
        <p className="text-sm text-muted-foreground py-1">No plan yet.</p>
      )}

      {comments.length > 0 && (
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
          {comments.map((c) => (
            <div key={c.id} className="rounded-md border border-border p-2">
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
        <form onSubmit={handleAddComment} className="flex flex-col gap-2 mt-2">
          <Textarea
            ref={commentInputRef}
            name="commentBody"
            placeholder="Write a plan update…"
            autoFocus
            required
            disabled={isCommentPending}
            className="text-xs min-h-16"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={isCommentPending}>
              {isCommentPending ? "Posting..." : "Post plan update"}
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
          className="mt-1 text-muted-foreground w-fit"
          onClick={() => setAddingComment(true)}
        >
          <PlusIcon />
          Add Plan Update
        </Button>
      )}
    </div>
  );
}
