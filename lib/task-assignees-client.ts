import type { ResolvedTaskAssignee } from "@/lib/task-assignment";

/**
 * Client read for the task assignee pickers via GET /api/panels/task-assignees.
 * Never a server action — see app/api/analytics/measurements/route.ts for why
 * reads must stay out of the Next router's action queue.
 */
export async function fetchTaskAssigneeOptions(orgSlug: string, workspaceSlug: string): Promise<ResolvedTaskAssignee[]> {
  const query = new URLSearchParams({ orgSlug, workspaceSlug });
  const response = await fetch(`/api/panels/task-assignees?${query}`);
  if (!response.ok) throw new Error(`Assignee request failed (${response.status})`);
  const body = (await response.json()) as { data: ResolvedTaskAssignee[] };
  return body.data;
}
