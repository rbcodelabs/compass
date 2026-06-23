"use client";

import { CheckInForm } from "@/components/okrs/check-in-form";

interface KeyResultBarProps {
  keyResult: {
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
  };
  orgSlug: string;
  workspaceSlug: string;
}

function clampProgress(current: number, target: number): number {
  if (target === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((current / target) * 100)));
}

export function KeyResultBar({ keyResult, orgSlug, workspaceSlug }: KeyResultBarProps) {
  const progress = clampProgress(keyResult.current, keyResult.target);
  const unit = keyResult.unit ? ` ${keyResult.unit}` : "";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-foreground">{keyResult.title}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {keyResult.current}{unit} / {keyResult.target}{unit}
          </span>
          <CheckInForm
            keyResultId={keyResult.id}
            keyResultTitle={keyResult.title}
            currentValue={keyResult.current}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground w-8 text-right">
          {progress}%
        </span>
      </div>
    </div>
  );
}
