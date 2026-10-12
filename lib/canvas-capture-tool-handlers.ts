/**
 * Handler for the `capture_canvas` MCP tool: a picture of a Canvas doc, or of a
 * section of it, returned inline so an agent can see what it is editing.
 *
 * Render path: canvas JSON -> self-contained HTML (lib/canvas-render.ts) ->
 * the sandbox browser's offline HTML mode (lib/capture-screenshot.ts). Nothing
 * is fetched and nothing is stored: the live editor needs a session and there
 * is no session-less render route, so the image is derived from the doc the
 * caller is already authorized to read and handed straight back.
 *
 * Authorization: the tool gate (lib/mcp-tool-gates.ts) proves the caller may
 * read the doc. Compass cards are then resolved against the DOC'S workspace, so
 * a reference into another workspace renders as "unavailable" exactly as it
 * does in the editor.
 */
import getPrisma from "@/lib/db"
import { getMcpActor } from "@/lib/mcp-authz"
import { fail, okWithImage } from "@/lib/mcp-output"
import { hydrateDocument } from "@/lib/document-service"
import { normalizeCanvasContent } from "@/lib/json-canvas"
import { decodeCanvasCard } from "@/lib/canvas-cards"
import { resolveCanvasCards } from "@/lib/canvas-card-data"
import { renderCanvasHtml, resolveCanvasView, type CanvasView } from "@/lib/canvas-render"
import { captureScreenshot, ScreenshotCaptureError } from "@/lib/capture-screenshot"

export type CaptureCanvasInput = {
  docId: string
  /** Focus on one node or group (padded). Mutually exclusive with `region`. */
  nodeId?: string
  /** Padding around the focused node, in canvas units. */
  padding?: number
  /** Explicit rectangle in canvas coordinates. Mutually exclusive with `nodeId`. */
  region?: { x: number; y: number; width: number; height: number }
  /** Output pixels per canvas unit. Defaults to fitting the view into ~1600px. */
  scale?: number
}

export async function captureCanvas(input: CaptureCanvasInput) {
  if (input.nodeId !== undefined && input.region !== undefined) {
    return fail("Pass either nodeId or region, not both. Omit both for a fit-all overview.")
  }

  const doc = await getPrisma().doc.findUnique({
    where: { id: input.docId },
    select: {
      id: true,
      title: true,
      docType: true,
      workspaceId: true,
      content: true,
      contentRef: true,
      storageProvider: true,
      workspace: { select: { slug: true, organization: { select: { slug: true } } } },
    },
  })
  if (!doc) return fail(`Doc "${input.docId}" not found.`)
  if (doc.docType !== "CANVAS") return fail(`Doc "${doc.title}" is a ${doc.docType} doc, not a Canvas. capture_canvas only renders CANVAS docs.`)

  let content: string
  try {
    content = (await hydrateDocument(doc.workspaceId, doc)).content ?? ""
  } catch (error) {
    return fail(`Could not read the canvas content: ${error instanceof Error ? error.message : "unknown error"}`)
  }
  const normalized = normalizeCanvasContent(content)
  if (!normalized.ok) return fail(normalized.error)
  const canvas = normalized.canvas

  const view: CanvasView = input.nodeId !== undefined
    ? { kind: "focus", nodeId: input.nodeId, padding: input.padding }
    : input.region !== undefined
      ? { kind: "region", ...input.region }
      : { kind: "overview" }
  const resolved = resolveCanvasView(canvas, view)
  if (!resolved.ok) return fail(resolved.error)

  const refs = canvas.nodes.flatMap((node) => {
    const card = decodeCanvasCard(node)
    return card ? [{ kind: card.kind, id: card.id }] : []
  })
  const slugs = { orgSlug: doc.workspace?.organization?.slug ?? "", workspaceSlug: doc.workspace?.slug ?? "" }
  const cards = refs.length
    ? await resolveCanvasCards({ workspaceId: doc.workspaceId, ...slugs, userId: getMcpActor().userId ?? "", refs })
    : {}

  const rendered = renderCanvasHtml(canvas, resolved.box, cards, { scale: input.scale })

  try {
    const capture = await captureScreenshot({ html: rendered.html, viewport: rendered.viewport })
    const { box } = rendered
    return okWithImage(
      `Rendered canvas "${doc.title}" (${view.kind}): canvas region x=${Math.round(box.x)} y=${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} ` +
        `at ${capture.image.width}x${capture.image.height}px — ${rendered.counts.nodes} nodes, ${rendered.counts.edges} edges` +
        (rendered.counts.cards ? `, ${rendered.counts.cards} Compass cards (${rendered.counts.unavailableCards} unavailable)` : "") +
        `.\nID: ${doc.id}`,
      { data: capture.png, mimeType: "image/png" },
      {
        docId: doc.id,
        view: view.kind,
        region: box,
        scale: rendered.scale,
        image: capture.image,
        byteSize: capture.png.length,
        counts: rendered.counts,
        timings: capture.timings,
      }
    )
  } catch (error) {
    if (error instanceof ScreenshotCaptureError) return fail(error.message)
    return fail(error instanceof Error ? error.message : "Could not capture canvas")
  }
}
