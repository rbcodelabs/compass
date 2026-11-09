"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createInheritanceRuleAction,
  deleteInheritanceRuleAction,
  moveInheritanceRuleAction,
  setInheritanceRuleEnabledAction,
  type InheritanceRuleActionResult,
} from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { checkRuleCompatibility } from "@/lib/custom-field-inheritance-compat";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import type { CustomFieldDefinitionData } from "@/lib/types";

export type InheritanceRuleRow = {
  id: string;
  priority: number;
  enabled: boolean;
  status: "active" | "disabled" | "inactive";
  inactiveReason: string | null;
  sourceObjectType: string;
  sourceFieldId: string;
  sourceFieldName: string | null;
  targetFieldId: string;
  targetFieldName: string | null;
};

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  fields: CustomFieldDefinitionData[];
  rules: InheritanceRuleRow[];
  /** False until migration 113 is applied: the section explains itself instead of failing. */
  available: boolean;
}

const STATUS_STYLE: Record<InheritanceRuleRow["status"], string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  disabled: "bg-muted text-muted-foreground",
  inactive: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function statusLabel(rule: InheritanceRuleRow) {
  if (rule.status === "inactive") return `Inactive: ${rule.inactiveReason ?? "needs attention"}`;
  return rule.status === "disabled" ? "Disabled" : "Active";
}

export function InheritanceRulesPanel({ orgSlug, workspaceSlug, fields, rules, available }: Props) {
  const router = useRouter();
  const labels = useLabels();
  // Workspaces rename these entities (thinking model); the copy follows.
  const opportunity = labels.opportunity.singular.toLowerCase();
  const solution = labels.solution.singular.toLowerCase();
  const SOURCE_LABEL: Record<string, string> = { OPPORTUNITY: opportunity, SOLUTION: solution };
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [targetFieldId, setTargetFieldId] = useState("");
  const [sourceFieldId, setSourceFieldId] = useState("");

  const targets = useMemo(() => fields.filter((field) => field.objectType === "ROADMAP_ITEM"), [fields]);
  const target = targets.find((field) => field.id === targetFieldId);
  // Only offer sources the server would accept: opportunity / solution fields of the same type with covered options.
  const sources = useMemo(
    () =>
      target
        ? fields.filter(
            (field) =>
              (field.objectType === "OPPORTUNITY" || field.objectType === "SOLUTION") &&
              checkRuleCompatibility(field, target) === null &&
              !rules.some((rule) => rule.targetFieldId === target.id && rule.sourceFieldId === field.id),
          )
        : [],
    [fields, target, rules],
  );

  function run(action: () => Promise<InheritanceRuleActionResult>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onDone?.();
        router.refresh();
      } catch {
        setError("Something went wrong");
      }
    });
  }

  const canAdd = available && targets.length > 0;

  return (
    <div className="flex flex-col gap-3" data-testid="inheritance-rules">
      <div>
        <h3 className="text-sm font-semibold">Inheritance rules</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A roadmap item field can default from a field on the {opportunity} or {solution} it is linked to. A rule only fills an empty field, never
          overwrites a value, and never keeps the two in sync. When several rules target one field, the lowest priority with a value wins.
        </p>
      </div>

      {!available && (
        <p className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground" data-testid="inheritance-rules-unavailable">
          Inheritance rules switch on once the 113_custom_field_inheritance_rules database update has been applied.
        </p>
      )}

      {available && rules.length === 0 && <p className="text-xs text-muted-foreground">No inheritance rules yet.</p>}

      {available && rules.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border" data-testid="inheritance-rules-list">
          <ul className="min-w-[640px] divide-y divide-border">
            {rules.map((rule, index) => {
              const sameTarget = rules.filter((candidate) => candidate.targetFieldId === rule.targetFieldId);
              const position = sameTarget.findIndex((candidate) => candidate.id === rule.id);
              return (
                <li key={rule.id} className="flex items-center justify-between gap-3 px-4 py-2.5" data-testid={`inheritance-rule-${index}`}>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground" title="Priority: lower runs first">
                      {rule.priority + 1}
                    </span>
                    <span className="text-sm">
                      <span className="font-medium">{rule.targetFieldName ?? "(missing field)"}</span>
                      <span className="text-muted-foreground"> on roadmap items from </span>
                      <span className="font-medium">{rule.sourceFieldName ?? "(missing field)"}</span>
                      <span className="text-muted-foreground"> on {SOURCE_LABEL[rule.sourceObjectType] ?? rule.sourceObjectType}</span>
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[rule.status]}`} data-testid={`inheritance-rule-status-${index}`}>
                      {statusLabel(rule)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={rule.enabled}
                      disabled={pending}
                      aria-label={`${rule.enabled ? "Disable" : "Enable"} rule for ${rule.targetFieldName ?? "field"}`}
                      onCheckedChange={(enabled) => run(() => setInheritanceRuleEnabledAction(orgSlug, workspaceSlug, rule.id, enabled))}
                    />
                    <button
                      type="button"
                      className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                      disabled={pending || position === 0}
                      aria-label="Raise priority"
                      onClick={() => run(() => moveInheritanceRuleAction(orgSlug, workspaceSlug, rule.id, "up"))}
                    >
                      <ArrowUpIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                      disabled={pending || position === sameTarget.length - 1}
                      aria-label="Lower priority"
                      onClick={() => run(() => moveInheritanceRuleAction(orgSlug, workspaceSlug, rule.id, "down"))}
                    >
                      <ArrowDownIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                      disabled={pending}
                      aria-label={`Delete rule for ${rule.targetFieldName ?? "field"}`}
                      onClick={() => run(() => deleteInheritanceRuleAction(orgSlug, workspaceSlug, rule.id))}
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive" data-testid="inheritance-rules-error">
          {error}
        </p>
      )}

      {canAdd && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          data-testid="inheritance-rule-add"
        >
          <PlusIcon className="size-3.5" />
          Add inheritance rule
        </button>
      )}

      {available && targets.length === 0 && (
        <p className="text-xs text-muted-foreground">Add a roadmap item custom field first; rules fill roadmap item fields.</p>
      )}

      {canAdd && adding && (
        <form
          className="flex flex-col gap-3 rounded-xl bg-muted/30 p-4 ring-1 ring-border"
          data-testid="inheritance-rule-form"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => createInheritanceRuleAction(orgSlug, workspaceSlug, { targetFieldId, sourceFieldId }),
              () => {
                setAdding(false);
                setTargetFieldId("");
                setSourceFieldId("");
              },
            );
          }}
        >
          <p className="text-sm font-medium">New inheritance rule</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inheritance-target">Roadmap item field</Label>
              <Select
                value={targetFieldId}
                onValueChange={(value) => {
                  setTargetFieldId(value ?? "");
                  setSourceFieldId("");
                }}
              >
                <SelectTrigger id="inheritance-target" aria-label="Roadmap item field" data-testid="inheritance-target">
                  <SelectValue placeholder="Choose a field" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((field) => (
                    <SelectItem key={field.id} value={field.id}>
                      {field.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inheritance-source">Inherit from</Label>
              <Select value={sourceFieldId} onValueChange={(value) => setSourceFieldId(value ?? "")} disabled={!target}>
                <SelectTrigger id="inheritance-source" aria-label="Inherit from" data-testid="inheritance-source">
                  <SelectValue placeholder={target ? "Choose a source field" : "Pick the roadmap item field first"} />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((field) => (
                    <SelectItem key={field.id} value={field.id}>
                      {field.name} ({SOURCE_LABEL[field.objectType] ?? field.objectType})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {target && sources.length === 0 && (
                <p className="text-xs text-muted-foreground">No {opportunity} or {solution} field has the same type and covers these options.</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending || !targetFieldId || !sourceFieldId} data-testid="inheritance-rule-save">
              Add rule
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
