"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createAgent, updateAgent, createAgentKey, revokeAgentKey } from "@/app/settings/agents/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "@/components/patterns/settings-section";

type AgentRow = { id: string; name: string; description: string | null; status: string; keys: { id: string; name: string; keyPrefix: string; revokedAt: Date | null; expiresAt: Date | null }[]; grants: { id: string; name: string; href: string; access: string; revoked: boolean }[] };

function AgentCard({ agent, enabled }: { agent: AgentRow; enabled: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [keyName, setKeyName] = useState("");
  const [expiry, setExpiry] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function run(action: () => Promise<unknown>) { setError(null); start(async () => { try { await action(); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); } }); }
  return <SettingsSection title={agent.name} description={`${agent.status === "ACTIVE" ? "Active" : "Suspended"} · ${agent.id}`}>
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      <div className="space-y-2"><Label htmlFor={`name-${agent.id}`}>Agent name</Label><Input id={`name-${agent.id}`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} disabled={pending || !enabled} /><Label htmlFor={`description-${agent.id}`}>Description</Label><Input id={`description-${agent.id}`} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} disabled={pending || !enabled} /></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending || !enabled || !name.trim()} onClick={() => run(() => updateAgent(agent.id, { name, description, status: agent.status as "ACTIVE" | "SUSPENDED" }))}>Save agent</Button><Button variant="outline" disabled={pending || (!enabled && agent.status !== "ACTIVE")} onClick={() => run(() => updateAgent(agent.id, { name: agent.name, description: agent.description ?? "", status: agent.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" }))}>{agent.status === "ACTIVE" ? "Suspend" : "Reactivate"}</Button></div>
      <div><h3 className="text-sm font-medium">Workspace access</h3>{!agent.grants.length && <p className="text-sm text-text-muted">Ask a workspace administrator to enable this agent in workspace settings.</p>}<ul className="space-y-1 text-sm">{agent.grants.map((g) => <li key={g.id}><Link href={g.href} className="underline">{g.name}</Link> · {g.revoked ? "Revoked" : g.access === "WRITE" ? "Read and write" : "Read only"}</li>)}</ul></div>
      <div className="space-y-2"><h3 className="text-sm font-medium">Agent keys</h3><p className="text-xs text-text-muted">To rotate, generate a replacement, update your client, then revoke the old key.</p>{agent.keys.map((k) => <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-default p-2 text-sm"><span>{k.name} · cmp_{k.keyPrefix}…<span className="block text-xs text-text-muted">{k.revokedAt ? "Revoked" : k.expiresAt ? `Expires ${k.expiresAt.toISOString()}` : "No expiry"}</span></span>{!k.revokedAt && <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => revokeAgentKey(k.id))}>Revoke {k.name}</Button>}</div>)}</div>
      {enabled && agent.status === "ACTIVE" && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { const key = await createAgentKey(agent.id, { name: keyName, expiresAt: expiry ? new Date(expiry).toISOString() : undefined }); setSecret(key.rawKey); setKeyName(""); }); }}><Label htmlFor={`key-${agent.id}`}>Key name</Label><Input id={`key-${agent.id}`} value={keyName} onChange={(e) => setKeyName(e.target.value)} required maxLength={120} disabled={pending} /><Label htmlFor={`expiry-${agent.id}`}>Optional expiry</Label><Input id={`expiry-${agent.id}`} type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={pending} /><Button type="submit" disabled={pending || !keyName.trim()}>Generate agent key</Button></form>}
      {secret && <div role="status" className="space-y-2 rounded-md border border-border-default bg-surface-subtle p-3"><p className="text-sm">Copy this key now. It will not be shown again.</p><code className="block break-all text-xs">{secret}</code><Button variant="outline" size="sm" onClick={() => setSecret(null)}>Hide key</Button></div>}
    </div>
  </SettingsSection>;
}

export function AccountAgentsPanel({ agents, enabled }: { agents: AgentRow[]; enabled: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return <div className="space-y-6">{!enabled && <p className="text-sm text-text-muted">Agent setup is currently disabled. Existing identities and access remain visible; you can suspend agents or revoke credentials.</p>}<SettingsSection title="Register an agent" description="Your agent can be enabled in any workspace you belong to, including other organizations."><form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); setError(null); start(async () => { try { await createAgent({ name }); setName(""); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Could not create agent"); } }); }}><Input aria-label="New agent name" placeholder="Agent name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} disabled={pending || !enabled} required /><Button type="submit" disabled={pending || !enabled || !name.trim()}>Create agent</Button></form>{error && <p role="alert" className="text-sm text-status-danger">{error}</p>}</SettingsSection>{!agents.length && <p className="text-sm text-text-muted">No registered agents yet.</p>}{agents.map((a) => <AgentCard key={`${a.id}-${a.name}-${a.status}`} agent={a} enabled={enabled} />)}</div>;
}
