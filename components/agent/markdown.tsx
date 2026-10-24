"use client"

import type { ComponentProps } from "react"

import { AgentLink } from "@/components/agent/entity-link-card"
import { AgentImage } from "@/components/agent/agent-image"
import { MarkdownContent } from "@/components/markdown-content"

/**
 * Agent transcript markdown: Compass entity links render as live cards (see
 * entity-link-card.tsx), and workspace images render inline (see agent-image.tsx).
 */
export function Markdown(props: Omit<ComponentProps<typeof MarkdownContent>, "linkComponent" | "imageComponent">) {
  return <MarkdownContent {...props} linkComponent={AgentLink} imageComponent={AgentImage} />
}
