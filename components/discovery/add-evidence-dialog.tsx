"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { addEvidence } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { EvidenceSourceType, EvidenceConfidence } from "@/lib/types";

const SOURCE_TYPE_LABELS: Record<EvidenceSourceType, string> = {
  interview: "Interview",
  feedback: "Feedback",
  support_ticket: "Support Ticket",
  experiment_result: "Experiment Result",
  analytics: "Analytics",
};

const CONFIDENCE_LABELS: Record<EvidenceConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

type NodeType = "opportunity" | "solution" | "assumption";

type Props = {
  workspaceId: string;
  nodeType: NodeType;
  nodeId: string;
  revalidatePathStr: string;
  /** Render a compact icon-only trigger instead of the full "Add Evidence" button. */
  compact?: boolean;
  /** Optional callback for client-fetched surfaces (e.g. the opportunity panel) that need to re-fetch after a mutation, since revalidatePath alone won't refresh client-side fetch state. */
  onMutated?: () => void;
};

export function AddEvidenceDialog({
  workspaceId,
  nodeType,
  nodeId,
  revalidatePathStr,
  compact = false,
  onMutated,
}: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [sourceType, setSourceType] = useState<EvidenceSourceType>("interview");
  const [confidence, setConfidence] = useState<EvidenceConfidence>("medium");
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const excerpt = (data.get("excerpt") as string).trim();
    if (!excerpt) return;
    const sourceUrl = (data.get("sourceUrl") as string).trim() || undefined;

    startTransition(async () => {
      await addEvidence(
        {
          workspaceId,
          sourceType,
          excerpt,
          confidence,
          sourceUrl,
          opportunityId: nodeType === "opportunity" ? nodeId : undefined,
          solutionId: nodeType === "solution" ? nodeId : undefined,
          assumptionId: nodeType === "assumption" ? nodeId : undefined,
        },
        revalidatePathStr
      );
      formRef.current?.reset();
      setSourceType("interview");
      setConfidence("medium");
      setOpen(false);
      onMutated?.();
    });
  }

  return (
    <>
      {compact ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          onClick={() => setOpen(true)}
          aria-label="Add evidence"
          title="Add evidence"
        >
          <PlusIcon className="size-3.5" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => setOpen(true)}
        >
          <PlusIcon />
          Add Evidence
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Add Evidence</DialogTitle>
          </DialogHeader>
          <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="evidence-source-type">Source type</Label>
                <Select
                  value={sourceType}
                  onValueChange={(v: string | null) => {
                    if (v) setSourceType(v as EvidenceSourceType);
                  }}
                  disabled={isPending}
                >
                  <SelectTrigger id="evidence-source-type" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SOURCE_TYPE_LABELS) as EvidenceSourceType[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {SOURCE_TYPE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 flex flex-col gap-1.5">
                <Label htmlFor="evidence-confidence">Confidence</Label>
                <Select
                  value={confidence}
                  onValueChange={(v: string | null) => {
                    if (v) setConfidence(v as EvidenceConfidence);
                  }}
                  disabled={isPending}
                >
                  <SelectTrigger id="evidence-confidence" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CONFIDENCE_LABELS) as EvidenceConfidence[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {CONFIDENCE_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evidence-excerpt">Excerpt</Label>
              <Textarea
                id="evidence-excerpt"
                name="excerpt"
                placeholder="Quote, summary, or data point supporting this..."
                autoFocus
                required
                disabled={isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evidence-source-url">Source URL (optional)</Label>
              <Input
                id="evidence-source-url"
                name="sourceUrl"
                type="url"
                placeholder="https://..."
                disabled={isPending}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "Adding..." : "Add Evidence"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
