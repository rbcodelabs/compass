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
import { createFeedback } from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import type { CreatedFeedbackItem } from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import type { FeedbackType } from "@/lib/types";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<FeedbackType, string> = {
  IDEA: "Idea",
  BUG: "Bug",
};

type Props = {
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  onCreated: (item: CreatedFeedbackItem) => void;
  /** Renders a call-to-action styled trigger for the board's empty state instead of the compact toolbar trigger. */
  variant?: "toolbar" | "empty-state";
};

export function CreateFeedbackDialog({
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  onCreated,
  variant = "toolbar",
}: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [type, setType] = useState<FeedbackType>("IDEA");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setError(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("title") as string).trim();
    const description = (data.get("description") as string).trim();
    if (!title) {
      setError("Title is required");
      return;
    }
    setError(null);

    startTransition(async () => {
      const result = await createFeedback(
        orgSlug,
        workspaceSlug,
        { title, description, type },
        revalidatePathStr
      );

      if (!result.ok) {
        setError(result.error);
        return;
      }

      onCreated(result.item);
      formRef.current?.reset();
      setType("IDEA");
      setOpen(false);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={variant === "empty-state" ? "default" : "outline"}
        size="sm"
        aria-label={variant === "toolbar" ? "New Feedback" : undefined}
        className={cn(
          "w-fit",
          variant === "toolbar" && "size-8 p-0 sm:h-8 sm:w-fit sm:px-3",
        )}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
        <span className={cn(variant === "toolbar" && "hidden sm:inline")}>
          New Feedback
        </span>
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>New Feedback</DialogTitle>
          </DialogHeader>
          <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-type">Type</Label>
              <Select
                value={type}
                onValueChange={(v: string | null) => {
                  if (v) setType(v as FeedbackType);
                }}
                disabled={isPending}
              >
                <SelectTrigger id="feedback-type" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_LABELS) as FeedbackType[]).map((t) => (
                    <SelectItem key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-title">Title</Label>
              <Input
                id="feedback-title"
                name="title"
                placeholder="Short summary..."
                autoFocus
                required
                disabled={isPending}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="feedback-description">Description (optional)</Label>
              <Textarea
                id="feedback-description"
                name="description"
                placeholder="More detail..."
                disabled={isPending}
              />
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "Submitting..." : "Submit"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
