import type { CSSProperties } from "react"

import { cn } from "@/lib/utils"

import { hueFor, initialFor, motifFor } from "./model"
import "./workspace-selector.css"

type AvatarSize = "sm" | "md" | "lg" | "xl"

type HueStyle = CSSProperties & { "--wsx-h": number }

function hueStyle(name: string): HueStyle {
  return { "--wsx-h": hueFor(name) }
}

/** Letter avatar tinted by a hash of the workspace name. Decorative: the name is always rendered beside it. */
export function WorkspaceAvatar({
  name,
  size = "md",
  readOnly = false,
  className,
}: {
  name: string
  size?: AvatarSize
  readOnly?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-readonly={readOnly}
      className={cn("wsx-avatar", `wsx-avatar-${size}`, className)}
      style={hueStyle(name)}
    >
      {initialFor(name)}
    </span>
  )
}

/** Generative gradient cover with a hash-chosen motif. Children render over the artwork. */
export function WorkspaceCover({
  name,
  readOnly = false,
  neutral = false,
  children,
}: {
  name: string
  readOnly?: boolean
  /** Hue-less grey cover (e.g. the OKRs "No cycle" tile); the tint comes from tokens, not the name hash. */
  neutral?: boolean
  children?: React.ReactNode
}) {
  return (
    <span
      className="wsx-cover"
      data-motif={neutral ? "contours" : motifFor(name)}
      data-neutral={neutral || undefined}
      data-readonly={readOnly}
      style={hueStyle(name)}
    >
      {children}
    </span>
  )
}
