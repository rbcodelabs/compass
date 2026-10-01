"use client";

import { useId, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addSolution } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

type Props = {
  /** Active (non-archived) Opportunities of this workspace: the parents a Solution can be added under. */
  opportunities: { id: string; title: string }[];
  orgSlug: string;
  workspaceSlug: string;
};

/**
 * "New solution" on the Solutions backlog. A Solution always belongs to an
 * Opportunity, so the parent picker is required. Creation goes through the same
 * `addSolution` server action as the Opportunity panel: that action derives the
 * Solution's workspace from the authorized parent, never from this form.
 */
export function NewSolutionDialog({ opportunities, orgSlug, workspaceSlug }: Props) {
  const labels = useLabels();
  const uid = useId();
  const titleId = `new-solution-title-${uid}`;
  const descId = `new-solution-description-${uid}`;
  const parentId = `new-solution-parent-${uid}`;
  const [open, setOpen] = useState(false);
  const [opportunityId, setOpportunityId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const noParents = opportunities.length === 0;
  const canSubmit = !isPending && opportunityId !== null && title.trim().length > 0;

  function reset() {
    setOpportunityId(null);
    setTitle("");
    setDescription("");
    setError(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next && isPending) return;
    if (!next) reset();
    setOpen(next);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || opportunityId === null) return;
    setError(null);
    startTransition(async () => {
      try {
        await addSolution(
          opportunityId,
          { title: title.trim(), description: description.trim() || undefined },
          `/${orgSlug}/${workspaceSlug}/solutions`
        );
        reset();
        setOpen(false);
      } catch {
        setError(`Could not add this ${labels.solution.lower}. Please try again.`);
      }
    });
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        {`New ${labels.solution.singular}`}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{`New ${labels.solution.singular}`}</DialogTitle>
              <DialogDescription>
                {`Every ${labels.solution.lower} belongs to one ${labels.opportunity.lower}. Choose which.`}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={parentId}>{labels.opportunity.singular}</Label>
              <Select
                value={opportunityId}
                onValueChange={(next) => setOpportunityId(next ? String(next) : null)}
                disabled={isPending || noParents}
              >
                <SelectTrigger id={parentId} aria-label={labels.opportunity.singular} aria-required="true" className="w-full">
                  <SelectValue placeholder={noParents ? `No ${labels.opportunity.lowerPlural} yet` : `Select ${labels.opportunity.lower}`} />
                </SelectTrigger>
                <SelectContent>
                  {opportunities.map((opportunity) => (
                    <SelectItem key={opportunity.id} value={opportunity.id}>
                      {opportunity.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {noParents && (
                <p className="text-xs text-text-subtle">{`Add one in Discovery first.`}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={titleId}>Title</Label>
              <Input
                id={titleId}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={`${labels.solution.singular} title`}
                required
                disabled={isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={descId}>Description (optional)</Label>
              <Textarea
                id={descId}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={`Describe the ${labels.solution.lower} approach...`}
                disabled={isPending}
              />
            </div>

            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" disabled={isPending} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {isPending ? "Adding..." : `Add ${labels.solution.singular}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
