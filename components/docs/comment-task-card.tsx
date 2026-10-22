import Link from "next/link"
import { cn } from "@/lib/utils"
import { cardStatus, formatDue, PRIORITY_LABELS, type CardPillTone, type CommentTaskCardData } from "@/lib/comment-task-card"

const PILL_TONE: Record<CardPillTone, string> = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  progress: "bg-status-warning-surface text-status-warning",
  queued: "bg-agent-accent-surface text-agent-accent",
  review: "bg-status-info-surface text-status-info",
  done: "bg-status-success-surface text-status-success",
  blocked: "bg-status-danger-surface text-status-danger",
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

/** The live task embedded under the Doc comment it was created from. */
export function CommentTaskCard({ card, taskHref }: { card: CommentTaskCardData; taskHref: string }) {
  const agent = card.assignee?.type === "AGENT"
  const status = cardStatus(card.status, card.assignee?.type ?? null)
  const due = formatDue(card.dueDate)
  return (
    <div
      data-testid="comment-task-card"
      data-task-id={card.taskId}
      data-agent={agent ? "true" : "false"}
      className={cn(
        "mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 rounded-lg border border-border-default border-l-[3px] bg-surface-panel p-2.5",
        agent ? "border-l-agent-accent" : "border-l-status-info",
      )}
    >
      <div className="flex items-center justify-between">
        <span data-testid="task-card-status" className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", PILL_TONE[status.tone])}>{status.label}</span>
        {card.displayId && <span className="font-mono text-xs text-text-subtle">{card.displayId}</span>}
      </div>
      <p className="m-0 min-w-0 break-words text-sm font-semibold text-text-primary [overflow-wrap:anywhere]">{card.title}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-subtle">
        {card.assignee && (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <span
              aria-hidden
              className={cn("flex size-[18px] items-center justify-center rounded-full text-[9px] font-bold text-text-inverse", agent ? "bg-agent-accent" : "bg-status-neutral")}
            >
              {agent ? "⚙" : initials(card.assignee.displayName)}
            </span>
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{card.assignee.displayName}</span>
            {!card.assignee.available && (
              <span
                data-testid="assignee-unavailable"
                title="This person or agent is no longer available in this workspace, so the task will not be picked up."
                className="rounded bg-status-warning-surface px-1.5 py-px text-[10px] font-semibold text-status-warning"
              >
                Unavailable
              </span>
            )}
            {agent && <span className="rounded bg-agent-accent-surface px-1.5 py-px text-[10px] font-semibold text-agent-accent">Agent</span>}
          </span>
        )}
        {due && <span>{due}</span>}
        <span className={cn(card.priority === "HIGH" || card.priority === "URGENT" ? "font-semibold text-status-warning" : "")}>{PRIORITY_LABELS[card.priority]}</span>
      </div>
      {agent && (card.status === "TODO" || card.status === "BACKLOG") && (
        <p className="m-0 text-xs text-text-subtle">
          {card.assignee?.agentKind === "CLOUD" ? "Assigned to a cloud agent: assigning starts a run. Open the task to follow it." : "Waiting in the agent’s task queue."}
        </p>
      )}
      <Link href={taskHref} className="text-xs font-semibold text-status-info hover:underline" data-testid="open-task-link">
        Open task {"→"}
      </Link>
    </div>
  )
}
