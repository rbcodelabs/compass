/**
 * Presentational Key Result progress row rendered *inside* ObjectiveNode.
 *
 * Not its own React Flow node type — T1 (design doc §3) shows KRs as part
 * of the Objective card, not separate connected nodes. Purely presentational,
 * unlike components/okrs/key-result-bar.tsx: no drag handle, no check-in
 * form, no delete menu.
 */
import { clampProgress } from "@/lib/okrs";

export interface CanvasKeyResultData {
  id: string;
  title: string;
  current: number;
  target: number;
  unit: string | null;
}

interface KeyResultNodeProps {
  keyResult: CanvasKeyResultData;
}

export function KeyResultNode({ keyResult }: KeyResultNodeProps) {
  const progress = clampProgress(keyResult.current, keyResult.target);
  const unit = keyResult.unit ? ` ${keyResult.unit}` : "";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-foreground truncate">{keyResult.title}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          {keyResult.current}
          {unit} / {keyResult.target}
          {unit}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-[10px] text-muted-foreground w-7 text-right">
          {progress}%
        </span>
      </div>
    </div>
  );
}
