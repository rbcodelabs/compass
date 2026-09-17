"use client";

import { useState, useTransition } from "react";
import { updateWorkspaceLimits } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import { Input } from "@/components/ui/input";

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  nowLimit: number | null;
  nextLimit: number | null;
}

type Field = "nowLimit" | "nextLimit";

/**
 * Purely visual/advisory WIP limits for the NOW and NEXT roadmap columns —
 * see docs/decisions/0005-compass-native-decision-gates.md and 0006 (both
 * Superseded). Crossing the limit has zero behavioral effect; it only
 * changes what the roadmap board header displays. Blank input = null = no
 * limit set, same meaning as never having configured one.
 */
export function DeliveryLimitsPanel({ orgSlug, workspaceSlug, nowLimit, nextLimit }: Props) {
  const [nowInput, setNowInput] = useState(nowLimit === null ? "" : String(nowLimit));
  const [nextInput, setNextInput] = useState(nextLimit === null ? "" : String(nextLimit));
  const [nowError, setNowError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function parseLimit(raw: string): number | null | "invalid" {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) return "invalid";
    return n;
  }

  function handleBlur(field: Field, raw: string) {
    const parsed = parseLimit(raw);
    const setError = field === "nowLimit" ? setNowError : setNextError;
    const setInput = field === "nowLimit" ? setNowInput : setNextInput;

    if (parsed === "invalid") {
      setError("Enter a whole number of 0 or more, or leave blank for no limit");
      return;
    }
    setError(null);
    setInput(parsed === null ? "" : String(parsed));

    startTransition(async () => {
      await updateWorkspaceLimits(orgSlug, workspaceSlug, { [field]: parsed });
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 py-3.5">
      <p className="text-xs text-muted-foreground">
        Shown as a count on the roadmap board&apos;s NOW and NEXT columns. Advisory only —
        going over the limit never blocks adding or promoting items.
      </p>
      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-1">
          <label htmlFor="now-limit-input" className="text-sm font-medium">
            NOW limit
          </label>
          <Input
            id="now-limit-input"
            data-testid="now-limit-input"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="No limit"
            className="w-28"
            value={nowInput}
            disabled={isPending}
            aria-invalid={!!nowError}
            onChange={(e) => setNowInput(e.target.value)}
            onBlur={(e) => handleBlur("nowLimit", e.target.value)}
          />
          {nowError && <span className="text-xs text-destructive">{nowError}</span>}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="next-limit-input" className="text-sm font-medium">
            NEXT limit
          </label>
          <Input
            id="next-limit-input"
            data-testid="next-limit-input"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="No limit"
            className="w-28"
            value={nextInput}
            disabled={isPending}
            aria-invalid={!!nextError}
            onChange={(e) => setNextInput(e.target.value)}
            onBlur={(e) => handleBlur("nextLimit", e.target.value)}
          />
          {nextError && <span className="text-xs text-destructive">{nextError}</span>}
        </div>
      </div>
    </div>
  );
}
