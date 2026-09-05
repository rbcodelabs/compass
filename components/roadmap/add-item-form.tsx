"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { addRoadmapItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card";
import type { Horizon } from "@/lib/types";

type AvailableKR = { id: string; title: string; objectiveTitle: string };
type AvailableSolution = { id: string; title: string; opportunityTitle: string };
type AvailableOpportunity = { id: string; title: string };
type AvailableExperiment = { id: string; title: string; status: string };

type Props = {
  workspaceId: string;
  horizon: Horizon;
  revalidatePathStr: string;
  onAdd?: (item: RoadmapCardData) => void;
  availableKRs?: AvailableKR[];
  availableSolutions?: AvailableSolution[];
  availableOpportunities?: AvailableOpportunity[];
  availableExperiments?: AvailableExperiment[];
};

export function AddItemForm({
  workspaceId,
  horizon,
  onAdd,
  availableKRs,
  availableSolutions,
  availableOpportunities,
  availableExperiments,
}: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [selectedKRId, setSelectedKRId] = useState<string | null>(null);
  const [selectedSolutionId, setSelectedSolutionId] = useState<string | null>(null);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string | null>(null);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  function reset() {
    setSelectedKRId(null);
    setSelectedSolutionId(null);
    setSelectedOpportunityId(null);
    setSelectedExperimentId(null);
    setIsPrivate(false);
    formRef.current?.reset();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("title") as string).trim();
    if (!title) return;

    const startDateRaw = (data.get("startDate") as string) || "";
    const endDateRaw = (data.get("endDate") as string) || "";
    const startDate = startDateRaw ? new Date(startDateRaw) : undefined;
    const endDate = endDateRaw ? new Date(endDateRaw) : undefined;

    startTransition(async () => {
      const item = await addRoadmapItem(
        workspaceId,
        {
          title,
          description: (data.get("description") as string).trim() || undefined,
          horizon,
          keyResultId: selectedKRId ?? undefined,
          solutionId: selectedSolutionId ?? undefined,
          opportunityId: selectedOpportunityId ?? undefined,
          experimentId: selectedExperimentId ?? undefined,
          startDate,
          endDate,
          isPrivate,
        }
      );
      const linkedExperiment = selectedExperimentId
        ? (availableExperiments?.find((e) => e.id === selectedExperimentId) ?? null)
        : null;
      onAdd?.({
        id: item.id,
        title: item.title,
        description: item.description ?? null,
        horizon: item.horizon as Horizon,
        sortOrder: item.sortOrder,
        isPrivate: item.isPrivate,
        solutionId: item.solutionId ?? null,
        keyResultId: item.keyResultId ?? null,
        opportunityId: item.opportunityId ?? null,
        experimentId: item.experimentId ?? null,
        feedbackId: null,
        startDate: item.startDate ? item.startDate.toISOString() : null,
        endDate: item.endDate ? item.endDate.toISOString() : null,
        solution: null,
        keyResult: null,
        opportunity: selectedOpportunityId
          ? (availableOpportunities?.find((o) => o.id === selectedOpportunityId) ?? null)
          : null,
        experiment: linkedExperiment
          ? { id: linkedExperiment.id, title: linkedExperiment.title }
          : null,
        feedback: null,
        // The add-item form has no squad picker (squad is set via
        // promoteToRoadmap's squadId param, not this manual-add path) — new
        // items always start unassigned here, same as before this field existed.
        squad: null,
        launchChecklist: null,
        deliveryStatus: "NOT_STARTED",
      });
      setOpen(false);
      reset();
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg px-2.5 py-2 text-xs font-medium text-text-subtle hover:text-indigo-600 hover:bg-surface-panel/70 transition-all duration-150"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add item
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-3 flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`item-title-${horizon}`}>Title</Label>
        <Input
          id={`item-title-${horizon}`}
          name="title"
          placeholder="What are you building?"
          autoFocus
          required
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`item-description-${horizon}`}>
          Description (optional)
        </Label>
        <Textarea
          id={`item-description-${horizon}`}
          name="description"
          placeholder="Optional details..."
          disabled={isPending}
          rows={2}
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-col gap-1.5 flex-1">
          <Label htmlFor={`item-start-date-${horizon}`}>Start date (optional)</Label>
          <Input
            id={`item-start-date-${horizon}`}
            name="startDate"
            type="date"
            disabled={isPending}
          />
        </div>
        <div className="flex flex-col gap-1.5 flex-1">
          <Label htmlFor={`item-end-date-${horizon}`}>End date (optional)</Label>
          <Input
            id={`item-end-date-${horizon}`}
            name="endDate"
            type="date"
            disabled={isPending}
          />
        </div>
      </div>

      {availableOpportunities && availableOpportunities.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`item-opportunity-${horizon}`}>Opportunity (optional)</Label>
          <Combobox
            items={[
              { value: "__none__", label: "— None —" },
              ...availableOpportunities.map((opp) => ({ value: opp.id, label: opp.title })),
            ]}
            value={selectedOpportunityId ?? "__none__"}
            onValueChange={(v) => setSelectedOpportunityId(v === "__none__" ? null : v)}
            disabled={isPending}
          >
            <ComboboxTrigger id={`item-opportunity-${horizon}`} size="sm">
              <ComboboxValue placeholder="Link to an opportunity…" />
            </ComboboxTrigger>
            <ComboboxContent />
          </Combobox>
        </div>
      )}

      {availableExperiments && availableExperiments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`item-experiment-${horizon}`}>Experiment (optional)</Label>
          <Combobox
            items={[
              { value: "__none__", label: "— None —" },
              ...availableExperiments.map((exp) => ({
                value: exp.id,
                label: exp.title,
                render: (
                  <>
                    <span className="text-muted-foreground text-xs mr-1">{exp.status} ·</span>
                    {exp.title}
                  </>
                ),
              })),
            ]}
            value={selectedExperimentId ?? "__none__"}
            onValueChange={(v) => setSelectedExperimentId(v === "__none__" ? null : v)}
            disabled={isPending}
          >
            <ComboboxTrigger id={`item-experiment-${horizon}`} size="sm">
              <ComboboxValue placeholder="Link to an experiment…" />
            </ComboboxTrigger>
            <ComboboxContent />
          </Combobox>
        </div>
      )}

      {availableKRs && availableKRs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`item-kr-${horizon}`}>Key Result (optional)</Label>
          <Combobox
            items={[
              { value: "__none__", label: "— None —" },
              ...availableKRs.map((kr) => ({
                value: kr.id,
                label: kr.title,
                render: (
                  <>
                    <span className="text-muted-foreground text-xs mr-1">{kr.objectiveTitle} /</span>
                    {kr.title}
                  </>
                ),
              })),
            ]}
            value={selectedKRId ?? "__none__"}
            onValueChange={(v) => setSelectedKRId(v === "__none__" ? null : v)}
            disabled={isPending}
          >
            <ComboboxTrigger id={`item-kr-${horizon}`} size="sm">
              <ComboboxValue placeholder="Link to a key result…" />
            </ComboboxTrigger>
            <ComboboxContent />
          </Combobox>
        </div>
      )}

      {availableSolutions && availableSolutions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`item-solution-${horizon}`}>Solution (optional)</Label>
          <Combobox
            items={[
              { value: "__none__", label: "— None —" },
              ...availableSolutions.map((sol) => ({
                value: sol.id,
                label: sol.title,
                render: (
                  <>
                    <span className="text-muted-foreground text-xs mr-1">{sol.opportunityTitle} /</span>
                    {sol.title}
                  </>
                ),
              })),
            ]}
            value={selectedSolutionId ?? "__none__"}
            onValueChange={(v) => setSelectedSolutionId(v === "__none__" ? null : v)}
            disabled={isPending}
          >
            <ComboboxTrigger id={`item-solution-${horizon}`} size="sm">
              <ComboboxValue placeholder="Link to a solution…" />
            </ComboboxTrigger>
            <ComboboxContent />
          </Combobox>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Checkbox
          id={`item-private-${horizon}`}
          checked={isPrivate}
          onCheckedChange={setIsPrivate}
          disabled={isPending}
        />
        <Label htmlFor={`item-private-${horizon}`} className="cursor-pointer text-xs font-normal text-muted-foreground">
          Private (hidden from public roadmap)
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding..." : "Add Item"}
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
