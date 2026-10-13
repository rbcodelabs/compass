/**
 * "Where is the user right now" context for the agent rail.
 *
 * The rail stays open while the user moves around the workspace, so "this
 * opportunity", "fix these", "what's blocking it" are only answerable if the
 * agent knows which page sits behind the rail. The client sends its current
 * relative URL with each turn; this module turns that claim into a short,
 * prompt-ready block.
 *
 * ## The URL is a claim, not an authority
 *
 * Nothing in the request body is trusted beyond its shape:
 *   - it must be a same-origin relative path (no scheme, no `//host`);
 *   - its first two segments must be the slugs of the workspace the turn is
 *     already authorized for — a URL naming any other workspace is dropped;
 *   - an entity it names is re-read through `getEntitySummary`, which filters by
 *     that workspace's id, so a foreign or nonexistent row yields nothing.
 *
 * Every failure degrades to `null` (the turn runs exactly as it did before this
 * feature), never to an error — same contract as lib/agent-context.ts.
 *
 * Unlike the "Send to agent" hand-off this is NOT turn-1-only and NEVER
 * persisted as a chat message: the page changes between turns, so it is
 * re-resolved and re-folded into the prompt on every turn.
 */

import { getEntitySummary } from "@/lib/entity-summary"
import { parseEntityLink } from "@/lib/entity-links"
import { resolveThinkingModel, type ThinkingModelSource } from "@/lib/thinking-model/resolve"

/** Longest URL we will look at. Real workspace URLs are far shorter. */
export const AGENT_PAGE_URL_MAX_LENGTH = 512

/** Longest single-line value (title, status…) copied into the prompt. */
const FIELD_MAX_CHARS = 200

/**
 * User-facing name for the workspace sections, keyed by the third URL segment.
 * A section missing here is not described at all — better silent than wrong.
 * `agent` is deliberately absent: that page is the agent, not a page behind it.
 */
const SECTION_LABELS: Record<string, string> = {
  home: "Home",
  discovery: "Discovery",
  solutions: "Solutions",
  roadmap: "Roadmap",
  okrs: "OKRs",
  experiments: "Experiments",
  feedback: "Feedback",
  tasks: "Tasks",
  docs: "Docs",
  canvas: "Canvas",
  capture: "Research capture",
  "card-sort": "Card sort",
  decisions: "Decisions",
  reviews: "Reviews",
  metrics: "Metrics",
  updates: "Updates",
  notifications: "Notifications",
  settings: "Settings",
}

export type AgentPageContext = {
  /** Section label, e.g. "Discovery". */
  section: string
  /** The entity the page or open detail panel shows, when there is one. */
  entity: {
    type: string
    typeLabel: string
    id: string
    title: string
    status: string | null
    meta: string | null
    description: string | null
  } | null
  /** The relative URL that was described, normalised (path + `?detail=` only). */
  path: string
  /** Labeled section for the turn's prompt. */
  promptBlock: string
}

export type ResolvePageContextInput = {
  /** Whatever the client sent as `pageUrl`. Untrusted. */
  pageUrl: unknown
  workspace: ThinkingModelSource & { id: string; orgSlug: string; workspaceSlug: string }
}

/** One line, bounded: a title cannot smuggle a newline-delimited fake section into the prompt. */
function oneLine(value: string | null | undefined): string | null {
  const flat = value?.replace(/\s+/g, " ").trim()
  if (!flat) return null
  return flat.length > FIELD_MAX_CHARS ? `${flat.slice(0, FIELD_MAX_CHARS - 1).trimEnd()}…` : flat
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export async function resolveAgentPageContext(input: ResolvePageContextInput): Promise<AgentPageContext | null> {
  try {
    return await resolve(input)
  } catch (error) {
    // A malformed URL or a non-UUID id must never fail a turn.
    console.warn("[agent-page-context] resolve failed; treating as no page context.", error)
    return null
  }
}

async function resolve({ pageUrl, workspace }: ResolvePageContextInput): Promise<AgentPageContext | null> {
  if (typeof pageUrl !== "string") return null
  if (pageUrl.length === 0 || pageUrl.length > AGENT_PAGE_URL_MAX_LENGTH) return null
  // Same-origin relative only. `//host/path` and `/\host` are protocol-relative
  // in a browser, so refuse them before URL parsing can treat them as paths.
  if (!pageUrl.startsWith("/") || pageUrl.startsWith("//") || pageUrl.startsWith("/\\")) return null

  const url = new URL(pageUrl, "http://compass.invalid")
  const segments = url.pathname.split("/").filter(Boolean).map(decode)
  if (segments.some((s) => s === null)) return null
  const [orgSlug, workspaceSlug, sectionKey] = segments as string[]

  // The URL must name the workspace this turn is authorized for. A page in a
  // different workspace is never described, whatever the caller's membership.
  if (orgSlug !== workspace.orgSlug || workspaceSlug !== workspace.workspaceSlug) return null

  // hasOwn: a path segment of `constructor` or `__proto__` must not resolve to an Object.prototype member.
  const sectionName = sectionKey ?? "home"
  const section = Object.hasOwn(SECTION_LABELS, sectionName) ? SECTION_LABELS[sectionName] : null
  if (!section) return null

  // Only the path and the `detail` param are described; other query params are
  // filters/sorts that would add noise and are not ours to echo.

  let entity: AgentPageContext["entity"] = null
  const link = parseEntityLink(pageUrl)
  if (link && link.orgSlug === orgSlug && link.workspaceSlug === workspaceSlug) {
    const labels = resolveThinkingModel(workspace).labels
    const summary = await getEntitySummary(link.type, link.id, workspace.id, labels)
    if (summary) {
      entity = {
        type: summary.type,
        typeLabel: summary.typeLabel,
        id: summary.id,
        title: oneLine(summary.title) ?? "(untitled)",
        status: oneLine(summary.status),
        meta: oneLine(summary.meta),
        description: oneLine(summary.description),
      }
    }
  }

  // Echo `?detail=` only when it is the thing that resolved; a bogus one is noise.
  const panelParam = entity && url.searchParams.get("detail") === `${entity.type}:${entity.id}` ? `?detail=${encodeURIComponent(url.searchParams.get("detail") as string)}` : ""
  const path = (entity ? url.pathname : `/${segments.slice(0, 3).map((s) => encodeURIComponent(s as string)).join("/")}`) + panelParam
  const lines = [`Section: ${section}`]
  if (entity) {
    lines.push(
      `Showing: ${entity.typeLabel} "${entity.title}" (id ${entity.id})` + (entity.status ? `, status ${entity.status}` : ""),
    )
    if (entity.meta) lines.push(`Detail: ${entity.meta}`)
    if (entity.description) lines.push(`Description: ${entity.description}`)
  }
  lines.push(`Page: ${path}`)

  const promptBlock =
    `### Where the user is right now\n${lines.join("\n")}\n` +
    `This is the page open behind this chat as of this message. Use it to resolve words like "this", "here" or "it" ` +
    `when the message does not say otherwise, but the user may have moved since earlier messages, and this is only a ` +
    `summary: read the entity with your tools before acting on it.`

  return { section, entity, path, promptBlock }
}
