import Link from "next/link"

export function PmInterviewHistory({ orgSlug, workspaceSlug, interviews = [] }: { orgSlug: string; workspaceSlug: string; interviews?: Array<{ id: string; disposition: string; generationState: string; agentConversationId?: string | null; createdAt: string | Date }> }) {
  if (!interviews.length) return null
  return <section className="border-t pt-4"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">PM interview history</h3><ul className="mt-2 space-y-2">{interviews.map(interview => <li key={interview.id}><Link className="text-sm underline" href={`/${orgSlug}/${workspaceSlug}/capture/pm/${interview.id}`}>{new Date(interview.createdAt).toLocaleDateString()} · {interview.agentConversationId ? "agent conversation" : interview.disposition === "PENDING" ? interview.generationState.toLowerCase() : interview.disposition.toLowerCase()}</Link></li>)}</ul></section>
}
