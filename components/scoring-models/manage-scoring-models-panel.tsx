"use client";

import { useState, useTransition } from "react";
import { PlusIcon, TrashIcon, ChevronDownIcon, ChevronRightIcon, ArchiveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createScoringModel,
  updateScoringModelDetails,
  updateScoringModelMetrics,
  archiveScoringModel,
  type ScoringMetricInput,
} from "@/app/[orgSlug]/settings/actions";
import type { ScoringModelData, ScoringFormulaType, MetricDirection } from "@/lib/types";

const FORMULA_TYPE_LABELS: Record<ScoringFormulaType, string> = {
  WEIGHTED_SUM: "Weighted Sum",
  MULTIPLICATIVE: "Multiplicative (RICE-style)",
};

const DIRECTION_LABELS: Record<MetricDirection, string> = {
  POSITIVE: "Positive",
  NEGATIVE: "Negative",
};

function emptyMetric(): ScoringMetricInput {
  return {
    key: "",
    label: "",
    minValue: 0,
    maxValue: 10,
    weight: 1,
    direction: "POSITIVE",
  };
}

// ─── Metric row editor (shared by create form and edit-metrics panel) ────────

function MetricRow({
  rowId,
  metric,
  onChange,
  onRemove,
  keyEditable,
}: {
  rowId: string;
  metric: ScoringMetricInput;
  onChange: (m: ScoringMetricInput) => void;
  onRemove: () => void;
  keyEditable: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr_5rem_5rem_5rem_7rem_auto] gap-2 items-end">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${rowId}-key`} className="text-[11px] text-muted-foreground">
          Key
        </Label>
        <Input
          id={`${rowId}-key`}
          className="h-7 text-xs"
          value={metric.key}
          disabled={!keyEditable}
          placeholder="reach"
          onChange={(e) =>
            onChange({ ...metric, key: e.target.value.trim().toLowerCase().replace(/\s+/g, "_") })
          }
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${rowId}-label`} className="text-[11px] text-muted-foreground">
          Label
        </Label>
        <Input
          id={`${rowId}-label`}
          className="h-7 text-xs"
          value={metric.label}
          placeholder="Reach"
          onChange={(e) => onChange({ ...metric, label: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${rowId}-min`} className="text-[11px] text-muted-foreground">
          Min
        </Label>
        <Input
          id={`${rowId}-min`}
          className="h-7 text-xs"
          type="number"
          value={metric.minValue}
          onChange={(e) => onChange({ ...metric, minValue: parseFloat(e.target.value) || 0 })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${rowId}-max`} className="text-[11px] text-muted-foreground">
          Max
        </Label>
        <Input
          id={`${rowId}-max`}
          className="h-7 text-xs"
          type="number"
          value={metric.maxValue}
          onChange={(e) => onChange({ ...metric, maxValue: parseFloat(e.target.value) || 0 })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${rowId}-weight`} className="text-[11px] text-muted-foreground">
          Weight
        </Label>
        <Input
          id={`${rowId}-weight`}
          className="h-7 text-xs"
          type="number"
          step="0.1"
          value={metric.weight}
          onChange={(e) => onChange({ ...metric, weight: parseFloat(e.target.value) || 0 })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${rowId}-direction`} className="text-[11px] text-muted-foreground">
          Direction
        </Label>
        <Select
          value={metric.direction}
          onValueChange={(v) => onChange({ ...metric, direction: v as MetricDirection })}
          // `items` lets <Select.Value> resolve "POSITIVE"/"NEGATIVE" to their
          // human labels immediately, without requiring the popup to have
          // been opened first (see workspace-scoring-panel.tsx for the same
          // fix and full explanation).
          items={DIRECTION_LABELS}
        >
          <SelectTrigger id={`${rowId}-direction`} className="h-7 text-xs w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="POSITIVE">Positive</SelectItem>
            <SelectItem value="NEGATIVE">Negative</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive transition-colors mb-1.5"
        aria-label={`Remove metric ${metric.label || metric.key}`}
      >
        <TrashIcon className="size-3.5" />
      </button>
    </div>
  );
}

function MetricsBuilder({
  idPrefix,
  metrics,
  setMetrics,
  keysEditable,
}: {
  idPrefix: string;
  metrics: ScoringMetricInput[];
  setMetrics: (m: ScoringMetricInput[]) => void;
  keysEditable: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {metrics.map((metric, i) => (
        <MetricRow
          key={i}
          rowId={`${idPrefix}-metric-${i}`}
          metric={metric}
          keyEditable={keysEditable}
          onChange={(m) => setMetrics(metrics.map((existing, idx) => (idx === i ? m : existing)))}
          onRemove={() => setMetrics(metrics.filter((_, idx) => idx !== i))}
        />
      ))}
      <button
        type="button"
        onClick={() => setMetrics([...metrics, emptyMetric()])}
        className="flex items-center gap-1.5 w-fit rounded-lg border border-dashed border-border/60 py-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
      >
        <PlusIcon className="w-3 h-3" />
        Add metric
      </button>
    </div>
  );
}

// ─── Create form ──────────────────────────────────────────────────────────────

function AddScoringModelForm({
  orgSlug,
  onAdded,
}: {
  orgSlug: string;
  onAdded: (model: ScoringModelData) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formulaType, setFormulaType] = useState<ScoringFormulaType>("WEIGHTED_SUM");
  const [metrics, setMetrics] = useState<ScoringMetricInput[]>([emptyMetric()]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setName("");
    setDescription("");
    setFormulaType("WEIGHTED_SUM");
    setMetrics([emptyMetric()]);
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);

    startTransition(async () => {
      try {
        const model = await createScoringModel(orgSlug, {
          name: name.trim(),
          description: description.trim() || undefined,
          formulaType,
          metrics: metrics.filter((m) => m.key && m.label),
        });
        onAdded({
          id: model.id,
          name: name.trim(),
          description: description.trim() || null,
          status: "ACTIVE",
          formulaType,
          version: 1,
          metrics: metrics
            .filter((m) => m.key && m.label)
            .map((m, i) => ({ id: `${model.id}-${i}`, ...m, description: m.description ?? null, order: i })),
        });
        setOpen(false);
        reset();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create scoring model");
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg border border-dashed border-border/60 py-2 px-3 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add scoring model
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-medium">New Scoring Model</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scoring-model-name">Name</Label>
          <Input
            id="scoring-model-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. RICE, ICE, Effort/Impact"
            autoFocus
            required
            disabled={isPending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="scoring-model-formula">Formula Type</Label>
          <Select
            value={formulaType}
            onValueChange={(v) => setFormulaType(v as ScoringFormulaType)}
            disabled={isPending}
            items={FORMULA_TYPE_LABELS}
          >
            <SelectTrigger id="scoring-model-formula" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FORMULA_TYPE_LABELS) as ScoringFormulaType[]).map((t) => (
                <SelectItem key={t} value={t}>
                  {FORMULA_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="scoring-model-description">Description</Label>
        <Textarea
          id="scoring-model-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this model is for and when to use it"
          disabled={isPending}
          rows={2}
        />
      </div>

      {formulaType === "MULTIPLICATIVE" && (
        <p className="text-xs text-amber-600">
          Multiplicative formulas require every metric&apos;s minimum value to be greater than 0
          (guards against divide-by-zero).
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Metrics</Label>
        <MetricsBuilder idPrefix="create" metrics={metrics} setMetrics={setMetrics} keysEditable />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Creating..." : "Create Scoring Model"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Existing model row (click to expand metrics editor) ─────────────────────

function ScoringModelRow({
  orgSlug,
  model,
  onUpdated,
  onArchived,
}: {
  orgSlug: string;
  model: ScoringModelData;
  onUpdated: (model: ScoringModelData) => void;
  onArchived: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(model.name);
  const [description, setDescription] = useState(model.description ?? "");
  const [formulaType, setFormulaType] = useState<ScoringFormulaType>(model.formulaType);
  const [metrics, setMetrics] = useState<ScoringMetricInput[]>(
    model.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      description: m.description ?? undefined,
      minValue: m.minValue,
      maxValue: m.maxValue,
      weight: m.weight,
      direction: m.direction,
    }))
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const metricsChanged =
    formulaType !== model.formulaType ||
    JSON.stringify(metrics) !==
      JSON.stringify(
        model.metrics.map((m) => ({
          key: m.key,
          label: m.label,
          description: m.description ?? undefined,
          minValue: m.minValue,
          maxValue: m.maxValue,
          weight: m.weight,
          direction: m.direction,
        }))
      );
  const detailsChanged = name !== model.name || description !== (model.description ?? "");

  function handleSaveDetails() {
    setError(null);
    startTransition(async () => {
      try {
        await updateScoringModelDetails(orgSlug, model.id, {
          name: name.trim(),
          description: description.trim() || undefined,
        });
        onUpdated({ ...model, name: name.trim(), description: description.trim() || null });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update details");
      }
    });
  }

  function handleSaveMetrics() {
    setError(null);
    startTransition(async () => {
      try {
        await updateScoringModelMetrics(orgSlug, model.id, {
          formulaType,
          metrics,
        });
        onUpdated({
          ...model,
          formulaType,
          version: model.version + 1,
          metrics: metrics.map((m, i) => ({ id: `${model.id}-${i}`, ...m, description: m.description ?? null, order: i })),
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update metrics");
      }
    });
  }

  function handleArchive() {
    startTransition(async () => {
      await archiveScoringModel(orgSlug, model.id);
      onArchived();
    });
  }

  return (
    <div className="flex flex-col">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center justify-between gap-3 px-4 py-2.5 w-full text-left hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          {expanded ? (
            <ChevronDownIcon className="size-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium">{model.name}</span>
          <Badge variant={model.status === "ACTIVE" ? "outline" : "secondary"}>
            {model.status}
          </Badge>
          <Badge variant="secondary">{FORMULA_TYPE_LABELS[model.formulaType]}</Badge>
          <span className="text-xs text-muted-foreground">v{model.version}</span>
          <span className="text-xs text-muted-foreground">
            {model.metrics.length} metric{model.metrics.length === 1 ? "" : "s"}
          </span>
        </div>
        {model.status === "ACTIVE" && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              handleArchive();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                handleArchive();
              }
            }}
            className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
            aria-label={`Archive ${model.name}`}
          >
            <ArchiveIcon className="size-4" />
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 flex flex-col gap-4 border-t border-border/60 bg-muted/20">
          <div className="grid grid-cols-2 gap-3 pt-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`edit-name-${model.id}`}>Name</Label>
              <Input
                id={`edit-name-${model.id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`edit-formula-${model.id}`}>Formula Type</Label>
              <Select
                value={formulaType}
                onValueChange={(v) => setFormulaType(v as ScoringFormulaType)}
                disabled={isPending}
                items={FORMULA_TYPE_LABELS}
              >
                <SelectTrigger id={`edit-formula-${model.id}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FORMULA_TYPE_LABELS) as ScoringFormulaType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {FORMULA_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-description-${model.id}`}>Description</Label>
            <Textarea
              id={`edit-description-${model.id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isPending}
              rows={2}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>
              Metrics{" "}
              <span className="font-normal text-muted-foreground">
                (keys are locked after creation — editing weights/bounds/adding/removing metrics
                bumps the model version; existing scores stay frozen to the version that produced
                them)
              </span>
            </Label>
            <MetricsBuilder
              idPrefix={`edit-${model.id}`}
              metrics={metrics}
              setMetrics={setMetrics}
              keysEditable={false}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={isPending || !detailsChanged}
              onClick={handleSaveDetails}
            >
              Save name/description
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !metricsChanged}
              onClick={handleSaveMetrics}
            >
              Save metrics (bumps version)
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

interface Props {
  orgSlug: string;
  initialModels: ScoringModelData[];
}

export function ManageScoringModelsPanel({ orgSlug, initialModels }: Props) {
  const [models, setModels] = useState(initialModels);

  return (
    <div className="flex flex-col gap-3">
      {models.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
          {models.map((model) => (
            <ScoringModelRow
              key={model.id}
              orgSlug={orgSlug}
              model={model}
              onUpdated={(updated) =>
                setModels((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
              }
              onArchived={() =>
                setModels((prev) =>
                  prev.map((m) => (m.id === model.id ? { ...m, status: "ARCHIVED" } : m))
                )
              }
            />
          ))}
        </div>
      )}

      {models.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No scoring models yet. Create one to let workspaces rank opportunities objectively (e.g.
          RICE or ICE).
        </p>
      )}

      <AddScoringModelForm orgSlug={orgSlug} onAdded={(m) => setModels((prev) => [...prev, m])} />
    </div>
  );
}
