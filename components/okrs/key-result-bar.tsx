"use client";

import * as React from "react";
import { useTransition } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { CheckInForm } from "@/components/okrs/check-in-form";
import { CardMenu } from "@/components/ui/card-menu";
import { deleteKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";

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
  const [, startTransition] = useTransition();
  const progress = clampProgress(keyResult.current, keyResult.target);
  const unit = keyResult.unit ? ` ${keyResult.unit}` : "";
  const okrsPath = `/${orgSlug}/${workspaceSlug}/okrs`;

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: keyResult.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function handleDelete() {
    startTransition(async () => {
      await deleteKeyResult(keyResult.id, okrsPath);
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-1.5 group touch-none">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Drag handle */}
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none rounded"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>
          <span className="text-sm text-foreground truncate">{keyResult.title}</span>
        </div>
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
          <CardMenu
            items={[
              {
                label: "Delete KR",
                onClick: () => handleDelete(),
                destructive: true,
              },
            ]}
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
