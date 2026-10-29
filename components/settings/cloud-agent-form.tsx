"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelCatalogPicker } from "@/components/settings/model-catalog-picker";
import type { AgentInvokePolicy } from "@/lib/agent-ownership";

export type CloudAgentModelOption = { value: string; label: string; provider?: string };
/** How the Model field renders: the searchable gateway-catalog picker, and a short helper text (why the list is limited). */
export type CloudAgentModelUi = { searchable?: boolean; note?: string | null };
/** `maxConcurrentRuns` / `maxRunsPerDay` are the typed text of the run limits; "" = use the default. */
export type CloudAgentFormValues = { name: string; description: string; instructions: string; model: string; invokePolicy: AgentInvokePolicy; maxConcurrentRuns: string; maxRunsPerDay: string };

/** Defaults shown as placeholders; the real ones live in lib/agent-limits.ts (kept literal here so the client bundle stays small). */
const CAP_PLACEHOLDERS = { concurrent: "5 (default)", daily: "100 (default)" };

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/**
 * The fields shared by "New cloud agent" and "Edit cloud agent". Controlled: the parent owns the values and the submit.
 * `showInvokePolicy` is for shared agents only; a personal agent is always invoked by its owner alone.
 */
export function CloudAgentFields({ values, onChange, models, modelUi, disabled, showInvokePolicy, showRunLimits = false }: { values: CloudAgentFormValues; onChange: (next: CloudAgentFormValues) => void; models: CloudAgentModelOption[]; modelUi?: CloudAgentModelUi; disabled?: boolean; showInvokePolicy: boolean; showRunLimits?: boolean }) {
  const id = useId();
  const set = <K extends keyof CloudAgentFormValues>(key: K, value: CloudAgentFormValues[K]) => onChange({ ...values, [key]: value });
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={`${id}-name`}>Agent name</Label>
    <Input id={`${id}-name`} value={values.name} maxLength={120} onChange={(e) => set("name", e.target.value)} disabled={disabled} required />
    <Label htmlFor={`${id}-description`}>Description</Label>
    <Input id={`${id}-description`} value={values.description} maxLength={2000} onChange={(e) => set("description", e.target.value)} disabled={disabled} />
    <Label htmlFor={`${id}-instructions`}>Instructions</Label>
    <Textarea id={`${id}-instructions`} value={values.instructions} maxLength={8000} rows={5} placeholder="What this agent is for and how it should work. Instructions guide the agent; they cannot widen its access." onChange={(e) => set("instructions", e.target.value)} disabled={disabled} />
    <Label id={`${id}-model-label`} htmlFor={`${id}-model`}>Model</Label>
    {modelUi?.searchable ? <ModelCatalogPicker labelId={`${id}-model-label`} value={values.model} onChange={(next) => set("model", next)} options={models} disabled={disabled} /> : <select id={`${id}-model`} className={selectClass} value={values.model} onChange={(e) => set("model", e.target.value)} disabled={disabled}>
      <option value="">System default</option>
      {values.model && !models.some((m) => m.value === values.model) && <option value={values.model}>{values.model} (no longer offered)</option>}
      {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </select>}
    {modelUi?.note && <p className="text-xs text-text-muted">{modelUi.note}</p>}
    {showRunLimits && <>
      <Label htmlFor={`${id}-max-concurrent`}>Concurrent run limit</Label>
      <Input id={`${id}-max-concurrent`} type="number" inputMode="numeric" min={1} max={50} step={1} value={values.maxConcurrentRuns} placeholder={CAP_PLACEHOLDERS.concurrent} onChange={(e) => set("maxConcurrentRuns", e.target.value)} disabled={disabled} />
      <Label htmlFor={`${id}-max-daily`}>Daily run limit</Label>
      <Input id={`${id}-max-daily`} type="number" inputMode="numeric" min={1} max={5000} step={1} value={values.maxRunsPerDay} placeholder={CAP_PLACEHOLDERS.daily} onChange={(e) => set("maxRunsPerDay", e.target.value)} disabled={disabled} />
      <p className="text-xs text-text-muted">Runs of this agent in progress at once, and runs it may start in any 24 hours. When a limit is reached, new runs (including from assignments) are refused with a message. Leave empty for the default.</p>
    </>}
    {showInvokePolicy && <>
      <Label htmlFor={`${id}-policy`}>Who can run this agent</Label>
      <select id={`${id}-policy`} className={selectClass} value={values.invokePolicy === "OWNER" ? "ADMINS" : values.invokePolicy} onChange={(e) => set("invokePolicy", e.target.value as AgentInvokePolicy)} disabled={disabled}>
        <option value="WORKSPACE_MEMBERS">Any workspace member</option>
        <option value="ADMINS">Workspace admins only</option>
      </select>
    </>}
  </div>;
}

export const EMPTY_CLOUD_AGENT_VALUES: CloudAgentFormValues = { name: "", description: "", instructions: "", model: "", invokePolicy: "WORKSPACE_MEMBERS", maxConcurrentRuns: "", maxRunsPerDay: "" };

/** The cap fields to send on save: only those the editor changed, so an untouched form never rewrites a limit. */
export function changedRunLimits(values: CloudAgentFormValues, initial: { maxConcurrentRuns?: number | null; maxRunsPerDay?: number | null }): { maxConcurrentRuns?: number | null; maxRunsPerDay?: number | null } {
  const out: { maxConcurrentRuns?: number | null; maxRunsPerDay?: number | null } = {};
  const parse = (text: string) => (text.trim() === "" ? null : Number(text));
  const concurrent = parse(values.maxConcurrentRuns);
  const daily = parse(values.maxRunsPerDay);
  if (concurrent !== (initial.maxConcurrentRuns ?? null)) out.maxConcurrentRuns = concurrent;
  if (daily !== (initial.maxRunsPerDay ?? null)) out.maxRunsPerDay = daily;
  return out;
}

export function runLimitText(value: number | null | undefined) {
  return value ? String(value) : "";
}
