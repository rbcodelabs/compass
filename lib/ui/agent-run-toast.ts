import { pushUndoToast } from "@/lib/ui/undo-toast";

/**
 * The part of lib/agent-task-trigger.ts's outcome the browser needs. Declared here (not imported) so a client component
 * that announces a run never pulls the server-only trigger module into its bundle.
 */
export type AgentRunNotice =
  | { status: "started"; agentName: string; conversationUrl: string }
  | { status: "already_running"; agentName: string; conversationUrl: string }
  | { status: "refused"; message: string; code?: string }
  | { status: "skipped" };

/**
 * After a task was assigned to a cloud agent (or a comment mentioned one), tell the person what happened to the RUN: it
 * started (with a way to follow it), it was already going, or it did not start and why. The assignment itself is saved in
 * every case. Refusals stay up longer than confirmations because the person has something to do about them.
 */
export function announceAgentRun(notice: AgentRunNotice | null | undefined): void {
  if (!notice || notice.status === "skipped") return;
  if (notice.status === "refused") {
    pushUndoToast({ message: notice.message, durationMs: 15000 });
    return;
  }
  const open = () => { window.location.assign(notice.conversationUrl); };
  pushUndoToast({
    message: notice.status === "started" ? `Started a run as ${notice.agentName}.` : `${notice.agentName} is already working on this task.`,
    actionLabel: "View run",
    onAction: open,
    durationMs: 12000,
  });
}
