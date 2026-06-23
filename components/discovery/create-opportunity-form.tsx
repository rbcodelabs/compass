"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createOpportunity } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { OpportunityStatus } from "@/lib/types";

type Props = {
  workspaceId: string;
};

export function CreateOpportunityForm({ workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<OpportunityStatus>("EXPLORING");
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("title") as string).trim();
    if (!title) return;

    startTransition(async () => {
      await createOpportunity(workspaceId, {
        title,
        description: (data.get("description") as string).trim() || undefined,
        customerSegment:
          (data.get("customerSegment") as string).trim() || undefined,
        status,
      });
      setOpen(false);
      formRef.current?.reset();
      setStatus("EXPLORING");
    });
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        New Opportunity
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-4 flex flex-col gap-3 w-full max-w-md"
    >
      <p className="text-sm font-medium">New Opportunity</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="opp-title">Title</Label>
        <Input
          id="opp-title"
          name="title"
          placeholder="What opportunity have you discovered?"
          autoFocus
          required
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="opp-description">Description (optional)</Label>
        <Textarea
          id="opp-description"
          name="description"
          placeholder="Describe the opportunity in more detail..."
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="opp-segment">Customer Segment (optional)</Label>
        <Input
          id="opp-segment"
          name="customerSegment"
          placeholder="e.g. Enterprise buyers, SMB ops teams"
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="opp-status">Initial Status</Label>
        <Select
          value={status}
          onValueChange={(v: string | null) => {
            if (v) setStatus(v as OpportunityStatus);
          }}
          disabled={isPending}
        >
          <SelectTrigger id="opp-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="EXPLORING">Exploring</SelectItem>
            <SelectItem value="VALIDATING">Validating</SelectItem>
            <SelectItem value="PRIORITIZED">Prioritized</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Creating..." : "Create Opportunity"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            formRef.current?.reset();
            setStatus("EXPLORING");
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
