"use client"

/**
 * React Flow node renderers for the chain graph: one per object (shape encodes type, fill is the type's series colour,
 * a corner badge plus text at full detail encode status) and one for a collapsed cluster. Memoised, and the zoom band is
 * a quantised store selector, so nodes re-render only when the band changes, not on every wheel tick.
 */
import { memo, useContext } from "react"
import { Handle, Position, useStore, type Node, type NodeProps, type ReactFlowState } from "@xyflow/react"
import { cn } from "@/lib/utils"
import { ChainGraphUiContext } from "./chain-graph-context"
import type { ClusterNode, MemberNode } from "@/lib/chain-graph/cluster"
import { seriesForGroupIndex, showsLabel, TYPE_LABEL, TYPE_SERIES, zoomBand, type ZoomBand } from "@/lib/chain-graph/presentation"
import type { ChainNodeType, StatusTone } from "@/lib/chain-graph/types"

export type ChainRFNode = Node<{ visible: MemberNode }, "chain">
export type ClusterRFNode = Node<{ visible: ClusterNode }, "cluster">

const selectBand = (s: ReactFlowState): ZoomBand => zoomBand(s.transform[2])

/** A distinct silhouette per type so type is never colour-only. */
const SHAPE: Record<ChainNodeType, string> = {
  OBJECTIVE: "9999px",
  OPPORTUNITY: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  SOLUTION: "none",
  ASSUMPTION: "polygon(50% 0, 100% 100%, 0 100%)",
  EXPERIMENT: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  ROADMAP_ITEM: "polygon(0 0, 72% 0, 100% 50%, 72% 100%, 0 100%)",
}

const TONE_BADGE: Record<StatusTone, string> = {
  neutral: "bg-status-neutral",
  info: "bg-status-info",
  success: "bg-status-success",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
}
const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-status-neutral",
  info: "text-status-info",
  success: "text-status-success",
  warning: "text-status-warning",
  danger: "text-status-danger",
}

function humanize(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ")
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function useDim(key: string, isCluster: boolean) {
  const ui = useContext(ChainGraphUiContext)
  const off = ui.traced !== null && !ui.traced.has(key)
  const unmatched = !isCluster && ui.matches !== null && !ui.matches.has(key)
  return {
    ui,
    selected: ui.selectedRep === key,
    className: off ? (ui.hideUnrelated ? "chain-node--hidden" : "chain-node--dim") : unmatched ? "chain-node--dim" : "",
  }
}

const ChainNodeView = memo(function ChainNodeView({ data }: NodeProps<ChainRFNode>) {
  const { node } = data.visible
  const band = useStore(selectBand)
  const { ui, selected, className } = useDim(node.key, false)
  const size = node.type === "OBJECTIVE" ? 24 : 18
  const labelled = showsLabel(band, node.type)
  const pinned = ui.pinned.has(node.key)

  return (
    <div
      className={cn("relative", className)}
      style={{ width: size, height: size }}
      role="button"
      aria-label={`${TYPE_LABEL[node.type]}: ${node.title}. Status ${humanize(node.status)}.`}
      aria-pressed={selected}
      onClick={() => ui.onSelect(node.key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          ui.onSelect(node.key)
        }
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div
        className={cn("size-full", selected && "outline-2 outline-offset-2 outline-primary", pinned && "outline-1 outline-offset-4 outline-border-strong")}
        style={{
          background: `var(--graph-series-${TYPE_SERIES[node.type]})`,
          ...(node.type === "OBJECTIVE" ? { borderRadius: "9999px" } : node.type === "SOLUTION" ? { borderRadius: 3 } : { clipPath: SHAPE[node.type] }),
        }}
      />
      <span className={cn("absolute -right-1 -top-1 size-2 rounded-full border border-surface-app", TONE_BADGE[node.tone])} aria-hidden />
      {labelled && (
        <span className="absolute left-full top-1/2 ml-2 flex max-w-[200px] -translate-y-1/2 flex-col rounded-sm bg-surface-app/85 px-1 leading-tight">
          <span className="truncate text-xs font-medium text-text-primary">{node.title}</span>
          {band === "full" && (
            <span className="truncate text-[10px] text-text-subtle">
              {TYPE_LABEL[node.type]} · <span className={TONE_TEXT[node.tone]}>{humanize(node.status)}</span>
            </span>
          )}
        </span>
      )}
    </div>
  )
})

const ClusterNodeView = memo(function ClusterNodeView({ data }: NodeProps<ClusterRFNode>) {
  const cluster = data.visible
  const band = useStore(selectBand)
  const { ui, selected, className } = useDim(cluster.key, true)
  const size = Math.round(26 + 5 * Math.sqrt(cluster.count))
  const series = seriesForGroupIndex(cluster.groupIndex)
  const dominant = (Object.entries(cluster.toneCounts) as Array<[StatusTone, number]>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const toggle = () => ui.onToggleGroup(cluster.groupId)

  return (
    <div
      className={cn("relative", className)}
      style={{ width: size, height: size }}
      role="button"
      aria-expanded={false}
      aria-label={`${cluster.label}: collapsed group of ${cluster.count}. Press Enter to expand.`}
      onClick={() => ui.onSelect(cluster.key)}
      onDoubleClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          toggle()
        }
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div
        className={cn(
          "flex size-full items-center justify-center rounded-full border-2 text-xs font-semibold text-text-inverse",
          selected || cluster.containsSelection || ui.selectedRep === cluster.key ? "border-primary" : "border-surface-app",
        )}
        style={{ background: `var(--graph-series-${series})` }}
      >
        {cluster.count}
      </div>
      {showsLabel(band, "cluster") && (
        <span className="absolute left-1/2 top-full mt-1 flex -translate-x-1/2 flex-col items-center rounded-sm bg-surface-app/85 px-1 leading-tight">
          <span className="max-w-[180px] truncate text-xs font-medium text-text-primary">{cluster.label}</span>
          {band === "full" && (
            <span className="text-[10px] text-text-subtle">
              {dominant.map(([tone, n]) => (
                <span key={tone} className={cn("mr-1", TONE_TEXT[tone])}>
                  {n} {tone}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  )
})

export const chainNodeTypes = { chain: ChainNodeView, cluster: ClusterNodeView }
