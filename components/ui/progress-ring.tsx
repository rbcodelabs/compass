import { cn } from "@/lib/utils";

interface ProgressRingProps {
  /** 0-100. Caller passes an already-clamped value. */
  value: number;
  /** px diameter */
  size?: number;
  strokeWidth?: number;
  /** Color class applied to the foreground arc, e.g. "text-primary" / "text-primary/60" */
  className?: string;
}

/**
 * Small inline SVG progress ring — the radial counterpart to the linear
 * progress bars used elsewhere on OKR cards. Hand-rolled (no new dependency)
 * to match the existing bar's visual language: a muted track with a primary
 * foreground arc, just drawn as a circle instead of a rectangle.
 */
export function ProgressRing({
  value,
  size = 20,
  strokeWidth = 3,
  className,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${value}% complete`}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        className="text-muted stroke-current"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className={cn("stroke-current transition-[stroke-dashoffset]", className)}
      />
    </svg>
  );
}
