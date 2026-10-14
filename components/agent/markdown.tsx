"use client"

import type { ComponentProps } from "react"

import { AgentLink } from "@/components/agent/entity-link-card"
import { MarkdownContent } from "@/components/markdown-content"

/** Agent transcript markdown: Compass entity links render as live cards (see entity-link-card.tsx). */
export function Markdown(props: Omit<ComponentProps<typeof MarkdownContent>, "linkComponent">) {
  return <MarkdownContent {...props} linkComponent={AgentLink} />
}
