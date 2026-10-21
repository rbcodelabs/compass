"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentInvokePolicy } from "@/lib/agent-ownership";

export type CloudAgentModelOption = { value: string; label: string };
export type CloudAgentFormValues = { name: string; description: string; instructions: string; model: string; invokePolicy: AgentInvokePolicy };

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * The fields shared by "New cloud agent" and "Edit cloud agent". Controlled: the parent owns the values and the submit.
 * `showInvokePolicy` is for shared agents only; a personal agent is always invoked by its owner alone.
 */
export function CloudAgentFields({ values, onChange, models, disabled, showInvokePolicy }: { values: CloudAgentFormValues; onChange: (next: CloudAgentFormValues) => void; models: CloudAgentModelOption[]; disabled?: boolean; showInvokePolicy: boolean }) {
  const id = useId();
  const set = <K extends keyof CloudAgentFormValues>(key: K, value: CloudAgentFormValues[K]) => onChange({ ...values, [key]: value });
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={`${id}-name`}>Agent name</Label>
    <Input id={`${id}-name`} value={values.name} maxLength={120} onChange={(e) => set("name", e.target.value)} disabled={disabled} required />
    <Label htmlFor={`${id}-description`}>Description</Label>
    <Input id={`${id}-description`} value={values.description} maxLength={2000} onChange={(e) => set("description", e.target.value)} disabled={disabled} />
    <Label htmlFor={`${id}-instructions`}>Instructions</Label>
    <Textarea id={`${id}-instructions`} value={values.instructions} maxLength={8000} rows={5} placeholder="What this agent is for and how it should work. Instructions guide the agent; they cannot widen its access." onChange={(e) => set("instructions", e.target.value)} disabled={disabled} />
    <Label htmlFor={`${id}-model`}>Model</Label>
    <select id={`${id}-model`} className={selectClass} value={values.model} onChange={(e) => set("model", e.target.value)} disabled={disabled}>
      <option value="">System default</option>
      {values.model && !models.some((m) => m.value === values.model) && <option value={values.model}>{values.model} (no longer offered)</option>}
      {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </select>
    {showInvokePolicy && <>
      <Label htmlFor={`${id}-policy`}>Who can run this agent</Label>
      <select id={`${id}-policy`} className={selectClass} value={values.invokePolicy === "OWNER" ? "ADMINS" : values.invokePolicy} onChange={(e) => set("invokePolicy", e.target.value as AgentInvokePolicy)} disabled={disabled}>
        <option value="WORKSPACE_MEMBERS">Any workspace member</option>
        <option value="ADMINS">Workspace admins only</option>
      </select>
    </>}
  </div>;
}

export const EMPTY_CLOUD_AGENT_VALUES: CloudAgentFormValues = { name: "", description: "", instructions: "", model: "", invokePolicy: "WORKSPACE_MEMBERS" };
