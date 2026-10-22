import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { TYPE_SERIES } from "@/lib/chain-graph/presentation"
import type { ChainNodeType } from "@/lib/chain-graph/types"

/** A distinct silhouette per type so type is never colour-only. */
const SHAPE: Record<ChainNodeType, string> = {
  OBJECTIVE: "9999px",
  OPPORTUNITY: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  SOLUTION: "none",
  ASSUMPTION: "polygon(50% 0, 100% 100%, 0 100%)",
  EXPERIMENT: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  ROADMAP_ITEM: "polygon(0 0, 72% 0, 100% 50%, 72% 100%, 0 100%)",
}

/**
 * Silhouette and fill for a node type. Single source of truth shared by the canvas node renderer and the toolbar key
 * (`TypeGlyph`), so the legend can never drift from what is drawn.
 */
export function typeShapeStyle(type: ChainNodeType): CSSProperties {
  return {
    background: `var(--graph-series-${TYPE_SERIES[type]})`,
    ...(type === "OBJECTIVE" ? { borderRadius: "9999px" } : type === "SOLUTION" ? { borderRadius: 3 } : { clipPath: SHAPE[type] }),
  }
}

/** Small decorative diagram glyph for a node type; the adjacent text label carries the accessible name. */
export function TypeGlyph({ type, dimmed = false, className }: { type: ChainNodeType; dimmed?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-testid={`type-glyph-${type}`}
      data-dimmed={dimmed ? "true" : "false"}
      className={cn("inline-block size-3 shrink-0", dimmed && "opacity-40", className)}
      style={typeShapeStyle(type)}
    />
  )
}
