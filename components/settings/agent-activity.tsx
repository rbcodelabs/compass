export type AgentActivityRow = { id: string; toolName: string; status: string; createdAt: Date; workspaceName: string; agentName: string };

export function AgentActivity({ rows }: { rows: AgentActivityRow[] }) {
  if (!rows.length) return <p className="text-sm text-text-muted">No recent agent activity.</p>;
  return <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="rounded-md border border-border-default p-3 text-sm"><span className="font-medium">{row.agentName} · {row.toolName}</span> · {row.status === "STARTED" ? "Outcome not recorded" : row.status.toLowerCase()}<p className="text-xs text-text-muted">{row.workspaceName} · {row.createdAt.toISOString()}</p></li>)}</ul>;
}
