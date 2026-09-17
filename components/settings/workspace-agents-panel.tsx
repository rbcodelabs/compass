"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { grantWorkspaceAgent, revokeWorkspaceAgent, approveAgentAccessRequest, denyAgentAccessRequest } from "@/app/settings/agents/actions";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type WorkspaceAgentRow = { id: string; name: string; ownerName: string; status: string; access: string | null; eligible: boolean };
// A self-service AgentAccessRequest awaiting this workspace admin's decision
// (Compass solution 538d6df0) — approving upserts the same AgentWorkspaceGrant
// row the manual "Save agent access" control below writes.
export type WorkspaceAgentAccessRequestRow = { id: string; agentName: string; ownerName: string; access: string };
export function WorkspaceAgentsPanel({ orgSlug, workspaceSlug, agents, pendingRequests = [], canManage, enabled }: { orgSlug: string; workspaceSlug: string; agents: WorkspaceAgentRow[]; pendingRequests?: WorkspaceAgentAccessRequestRow[]; canManage: boolean; enabled: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [access, setAccess] = useState<"READ" | "WRITE">("READ");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(action: () => Promise<void>) { setError(null); start(async () => { try { await action(); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Agent access update failed"); } }); }
  const granted = agents.filter((a) => a.access);
  return <div className="min-w-0 space-y-4"><Link href="/settings/agents" className="text-sm underline">Manage my account-wide agents and keys</Link>{!granted.length && <p className="text-sm text-text-muted">No agents enabled for this workspace.</p>}<ul className="space-y-2">{granted.map((a) => <li key={a.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border-default p-3"><div className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">{a.name}<p className="text-xs font-normal text-text-muted">{a.ownerName} · {a.access === "WRITE" ? "Read and write" : "Read only"}{a.status !== "ACTIVE" || !a.eligible ? " · Unavailable" : ""}</p></div>{canManage && <Button variant="outline" size="sm" aria-label={`Revoke access to ${a.name}`} disabled={pending} onClick={() => run(() => revokeWorkspaceAgent(orgSlug, workspaceSlug, a.id))}>Revoke access</Button>}</li>)}</ul>
  {canManage && pendingRequests.length > 0 && <div className="space-y-2"><h3 className="text-sm font-medium">Pending access requests</h3><ul className="space-y-2">{pendingRequests.map((r) => <li key={r.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border-default p-3"><div className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">{r.agentName}<p className="text-xs font-normal text-text-muted">{r.ownerName} · requested {r.access === "WRITE" ? "read and write" : "read only"}</p></div><div className="flex shrink-0 gap-2"><Button size="sm" aria-label={`Approve access request from ${r.agentName}`} disabled={pending} onClick={() => run(() => approveAgentAccessRequest(r.id))}>Approve</Button><Button variant="outline" size="sm" aria-label={`Deny access request from ${r.agentName}`} disabled={pending} onClick={() => run(() => denyAgentAccessRequest(r.id))}>Deny</Button></div></li>)}</ul></div>}
  {canManage && <div className="flex min-w-0 flex-col gap-2"><p className="text-sm">Enable an agent belonging to a current workspace member, or update its access.</p><Select value={selected} onValueChange={(v) => setSelected(v ?? "")} disabled={pending || !enabled}><SelectTrigger aria-label="Workspace agent" className="max-w-full"><SelectValue placeholder="Choose an agent" /></SelectTrigger><SelectContent>{agents.filter((a) => a.eligible && a.status === "ACTIVE").map((a) => <SelectItem key={a.id} value={a.id}>{a.name} · {a.ownerName} · {a.id.slice(0, 8)}</SelectItem>)}</SelectContent></Select><Select value={access} onValueChange={(v) => setAccess(v as "READ" | "WRITE")} disabled={pending || !enabled}><SelectTrigger aria-label="Agent access"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="READ">Read only</SelectItem><SelectItem value="WRITE">Read and write</SelectItem></SelectContent></Select><Button disabled={pending || !enabled || !selected} onClick={() => run(() => grantWorkspaceAgent(orgSlug, workspaceSlug, selected, access))}>Save agent access</Button></div>}{error && <p role="alert" className="text-sm text-status-danger">{error}</p>}</div>;
}
