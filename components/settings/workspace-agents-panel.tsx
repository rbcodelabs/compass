"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createCloudAgent, grantWorkspaceAgent, revokeWorkspaceAgent, setMyDefaultAgentAction, setWorkspaceDefaultAgentAction, updateCloudAgent } from "@/app/settings/agents/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { changedRunLimits, CloudAgentFields, EMPTY_CLOUD_AGENT_VALUES, runLimitText, type CloudAgentFormValues, type CloudAgentModelOption } from "@/components/settings/cloud-agent-form";
import type { AgentInvokePolicy } from "@/lib/agent-ownership";

export type WorkspaceAgentRow = {
  id: string;
  name: string;
  ownerName: string;
  status: string;
  access: string | null;
  eligible: boolean;
  /** EXTERNAL agents authenticate with keys; CLOUD agents run in Compass's sandbox. Absent = EXTERNAL (older callers). */
  kind?: "EXTERNAL" | "CLOUD";
  /** Shared = owned by the workspace; otherwise personal to `ownerName`. */
  shared?: boolean;
  description?: string | null;
  /** Only sent for agents the viewer may edit. */
  instructions?: string | null;
  model?: string | null;
  invokePolicy?: AgentInvokePolicy | null;
  /** Configured run limits (null = default). Only sent for agents the viewer may edit. */
  maxConcurrentRuns?: number | null;
  maxRunsPerDay?: number | null;
  canEdit?: boolean;
  /** The viewer could start a run as this agent right now (cloud, active, enabled here, allowed by its policy). */
  canUse?: boolean;
  isWorkspaceDefault?: boolean;
  isMyDefault?: boolean;
};

function CloudAgentEditor({ agent, models, disabled, onSave }: { agent: WorkspaceAgentRow; models: CloudAgentModelOption[]; disabled: boolean; onSave: (values: CloudAgentFormValues) => void }) {
  const [values, setValues] = useState<CloudAgentFormValues>({ name: agent.name, description: agent.description ?? "", instructions: agent.instructions ?? "", model: agent.model ?? "", invokePolicy: agent.invokePolicy ?? "WORKSPACE_MEMBERS", maxConcurrentRuns: runLimitText(agent.maxConcurrentRuns), maxRunsPerDay: runLimitText(agent.maxRunsPerDay) });
  return <form className="mt-3 min-w-0 space-y-2 border-t border-border-default pt-3" aria-label={`Edit ${agent.name}`} onSubmit={(e) => { e.preventDefault(); onSave(values); }}>
    <CloudAgentFields values={values} onChange={setValues} models={models} disabled={disabled} showInvokePolicy={!!agent.shared} showRunLimits />
    <Button type="submit" size="sm" disabled={disabled || !values.name.trim()}>Save agent</Button>
  </form>;
}

export function WorkspaceAgentsPanel({ orgSlug, workspaceSlug, agents, canManage, enabled, models = [] }: { orgSlug: string; workspaceSlug: string; agents: WorkspaceAgentRow[]; canManage: boolean; enabled: boolean; models?: CloudAgentModelOption[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState("");
  const [access, setAccess] = useState<"READ" | "WRITE">("READ");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [ownerType, setOwnerType] = useState<"USER" | "WORKSPACE">("USER");
  const [newAccess, setNewAccess] = useState<"READ" | "WRITE">("READ");
  const [draft, setDraft] = useState<CloudAgentFormValues>(EMPTY_CLOUD_AGENT_VALUES);
  function run(action: () => Promise<unknown>, after?: () => void) { setError(null); setNotice(null); start(async () => { try { await action(); after?.(); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Agent update failed"); } }); }
  const granted = agents.filter((a) => a.access);
  const defaultAgent = agents.find((a) => a.isWorkspaceDefault);
  return <div className="min-w-0 space-y-4">
    <Link href="/settings/agents" className="text-sm underline">Manage my account-wide agents and keys</Link>
    {defaultAgent && <p className="text-sm text-text-muted">Workspace default: <span className="font-medium text-text-default">{defaultAgent.name}</span>. Used for chat and Send to agent unless a member picks another.</p>}
    {!granted.length && <p className="text-sm text-text-muted">No agents enabled for this workspace.</p>}
    {/* A list of wrapping rows rather than a fixed-width table: nothing squashes, and a long name or badge row wraps instead of clipping. */}
    <ul className="space-y-2">{granted.map((a) => <li key={a.id} className="min-w-0 rounded-md border border-border-default p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 max-w-full flex-1 basis-48 break-words text-sm font-medium [overflow-wrap:anywhere]">{a.name}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge variant="outline">{a.kind === "CLOUD" ? "Cloud" : "External"}</Badge>
            <Badge variant="secondary">{a.shared ? "Shared" : "Personal"}</Badge>
            {a.isWorkspaceDefault && <Badge>Workspace default</Badge>}
            {a.isMyDefault && <Badge>My default</Badge>}
          </div>
          <p className="mt-1 text-xs font-normal text-text-muted">{a.shared ? "Workspace" : a.ownerName} · {a.access === "WRITE" ? "Read and write" : "Read only"}{a.status !== "ACTIVE" || !a.eligible ? " · Unavailable" : ""}</p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          {/* The visible label is short on purpose: a 120-character agent name inside a button cannot wrap and pushed the whole card
              past a phone's edge. The accessible name still carries it. */}
          {a.kind === "CLOUD" && a.canEdit && <Button variant="outline" size="sm" aria-expanded={editing === a.id} aria-label={editing === a.id ? `Close ${a.name}` : `Edit ${a.name}`} title={editing === a.id ? undefined : `Edit ${a.name}`} disabled={pending} onClick={() => setEditing(editing === a.id ? null : a.id)}>{editing === a.id ? "Close" : "Edit"}</Button>}
          {a.kind === "CLOUD" && a.canUse && (a.isMyDefault
            ? <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => setMyDefaultAgentAction(orgSlug, workspaceSlug, null))}>Clear my default</Button>
            : <Button variant="outline" size="sm" disabled={pending || !enabled} onClick={() => run(() => setMyDefaultAgentAction(orgSlug, workspaceSlug, a.id))}>Use as my default</Button>)}
          {a.kind === "CLOUD" && canManage && a.shared && (a.isWorkspaceDefault
            ? <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => setWorkspaceDefaultAgentAction(orgSlug, workspaceSlug, null))}>Clear workspace default</Button>
            : a.status === "ACTIVE" && <Button variant="outline" size="sm" disabled={pending || !enabled} onClick={() => run(() => setWorkspaceDefaultAgentAction(orgSlug, workspaceSlug, a.id))}>Set as workspace default</Button>)}
          {canManage && <Button variant="outline" size="sm" aria-label={`Revoke access to ${a.name}`} disabled={pending} onClick={() => run(() => revokeWorkspaceAgent(orgSlug, workspaceSlug, a.id))}>Revoke access</Button>}
        </div>
      </div>
      {editing === a.id && <CloudAgentEditor agent={a} models={models} disabled={pending || !enabled} onSave={(values) => run(() => updateCloudAgent(a.id, { name: values.name, description: values.description, instructions: values.instructions, model: values.model || null, ...(a.shared ? { invokePolicy: values.invokePolicy === "OWNER" ? "ADMINS" : values.invokePolicy } : {}), ...changedRunLimits(values, a) }), () => setEditing(null))} />}
    </li>)}</ul>
    {enabled && (creating
      ? <form className="min-w-0 space-y-2 rounded-md border border-border-default p-3" aria-label="New cloud agent" onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const result = await createCloudAgent({ orgSlug, workspaceSlug, name: draft.name, description: draft.description, instructions: draft.instructions, model: draft.model || null, ownerType, access: newAccess, ...(ownerType === "WORKSPACE" ? { invokePolicy: draft.invokePolicy === "OWNER" ? "ADMINS" : draft.invokePolicy } : {}) });
            setNotice(result.enabledInWorkspace ? "Agent created and enabled in this workspace." : "Agent created. A workspace administrator needs to enable it before it can run here.");
          }, () => { setCreating(false); setDraft(EMPTY_CLOUD_AGENT_VALUES); });
        }}>
        <h3 className="text-sm font-medium">New cloud agent</h3>
        <Label htmlFor="new-agent-owner">Owner</Label>
        <select id="new-agent-owner" className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm" value={ownerType} onChange={(e) => setOwnerType(e.target.value as "USER" | "WORKSPACE")} disabled={pending}>
          <option value="USER">Personal (only you can run it)</option>
          {canManage && <option value="WORKSPACE">Shared (owned by this workspace)</option>}
        </select>
        <CloudAgentFields values={draft} onChange={setDraft} models={models} disabled={pending} showInvokePolicy={ownerType === "WORKSPACE"} />
        {canManage && <>
          <Label htmlFor="new-agent-access">Access in this workspace</Label>
          <select id="new-agent-access" className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm" value={newAccess} onChange={(e) => setNewAccess(e.target.value as "READ" | "WRITE")} disabled={pending}>
            <option value="READ">Read only</option>
            <option value="WRITE">Read and write</option>
          </select>
        </>}
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending || !draft.name.trim()}>Create agent</Button><Button type="button" variant="outline" disabled={pending} onClick={() => setCreating(false)}>Cancel</Button></div>
      </form>
      : <Button variant="outline" onClick={() => setCreating(true)}>New cloud agent</Button>)}
    {canManage && <div className="flex min-w-0 flex-col gap-2"><p className="text-sm">Enable an agent belonging to a current workspace member, or update its access.</p><Select value={selected} onValueChange={(v) => setSelected(v ?? "")} disabled={pending || !enabled}><SelectTrigger aria-label="Workspace agent" className="max-w-full"><SelectValue placeholder="Choose an agent" /></SelectTrigger><SelectContent>{agents.filter((a) => a.eligible && a.status === "ACTIVE").map((a) => <SelectItem key={a.id} value={a.id}>{a.name} · {a.ownerName} · {a.id.slice(0, 8)}</SelectItem>)}</SelectContent></Select><Select value={access} onValueChange={(v) => setAccess(v as "READ" | "WRITE")} disabled={pending || !enabled}><SelectTrigger aria-label="Agent access"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="READ">Read only</SelectItem><SelectItem value="WRITE">Read and write</SelectItem></SelectContent></Select><Button disabled={pending || !enabled || !selected} onClick={() => run(() => grantWorkspaceAgent(orgSlug, workspaceSlug, selected, access))}>Save agent access</Button></div>}
    {notice && <p role="status" className="text-sm text-text-muted">{notice}</p>}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
  </div>;
}
