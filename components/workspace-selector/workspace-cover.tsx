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
  children,
}: {
  name: string
  readOnly?: boolean
  children?: React.ReactNode
}) {
  return (
    <span className="wsx-cover" data-motif={motifFor(name)} data-readonly={readOnly} style={hueStyle(name)}>
      {children}
    </span>
  )
}
