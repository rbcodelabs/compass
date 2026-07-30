"use client";

import { useState, useTransition, useRef } from "react";
import { MessageSquarePlus } from "lucide-react";
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
import { sendCompassFeedback } from "@/lib/meta-feedback-actions";
import type { FeedbackType } from "@/lib/types";

const TYPE_LABELS: Record<FeedbackType, string> = {
  IDEA: "Idea",
  BUG: "Bug",
};

type Props = {
  /** Renders an icon-only trigger for the mobile header action row instead of the full sidebar link. */
  compact?: boolean;
};

const TRIGGER_LABEL = "Send Feedback about Compass";

export function SendCompassFeedbackDialog({ compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [type, setType] = useState<FeedbackType>("IDEA");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  function reset() {
    setType("IDEA");
    setError(null);
    setSubmitted(false);
    formRef.current?.reset();
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
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
      const result = await sendCompassFeedback({ title, description, type });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSubmitted(true);
    });
  }

  return (
    <>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex flex-col items-center justify-center w-14 h-10 rounded-lg gap-0.5 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition-colors"
          aria-label={TRIGGER_LABEL}
        >
          <MessageSquarePlus className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none">Feedback</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-slate-400 transition-all duration-150 hover:bg-slate-800/50 hover:text-slate-200"
        >
          <MessageSquarePlus className="w-4 h-4 shrink-0 text-slate-500" aria-hidden="true" />
          {TRIGGER_LABEL}
        </button>
      )}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>{TRIGGER_LABEL}</DialogTitle>
          </DialogHeader>

          {submitted ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-slate-600">
                Thanks — your feedback was sent to the Compass team.
              </p>
              <DialogFooter>
                <Button type="button" size="sm" onClick={() => handleOpenChange(false)}>
                  Close
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="compass-feedback-type">Type</Label>
                <Select
                  value={type}
                  onValueChange={(v: string | null) => {
                    if (v) setType(v as FeedbackType);
                  }}
                  disabled={isPending}
                >
                  <SelectTrigger id="compass-feedback-type" size="sm">
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
                <Label htmlFor="compass-feedback-title">Title</Label>
                <Input
                  id="compass-feedback-title"
                  name="title"
                  placeholder="Short summary..."
                  autoFocus
                  required
                  disabled={isPending}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="compass-feedback-description">Description (optional)</Label>
                <Textarea
                  id="compass-feedback-description"
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
                  {isPending ? "Sending..." : "Send"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
