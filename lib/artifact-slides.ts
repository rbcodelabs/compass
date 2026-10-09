import { readArtifactKind } from "@/lib/artifact-kind"
import { buildSandboxedHtml } from "@/lib/artifact-preview-html"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { withSlideFit } from "@/lib/slide-fit"
import { parseSlideDeck } from "@/lib/slide-parser"

/**
 * Server-side presentation of an Artifact's stored HTML.
 *
 * A SLIDE_DECK keeps the whole uploaded document as its revision; nothing about
 * slides is persisted. It is split here at read time with the parser ported from
 * Commenter, so a replaced revision, or a later parser fix, applies to every deck
 * without a backfill. Slide indexes are zero-based and are what
 * `comment_element_anchors.slide_index` stores.
 *
 * Server-only: `slide-parser` pulls in cheerio.
 */
export type ArtifactSlideDto = {
  index: number
  title: string | null
  description: string | null
  /** The slide's standalone document, already wrapped in the preview CSP. */
  html: string
}

export type ArtifactPresentation = {
  /** The whole document, sandboxed. Always present, so DOCUMENT rendering is unchanged. */
  html: string
  /** Present only for a SLIDE_DECK that actually splits into slides. */
  slides?: ArtifactSlideDto[]
}

export function buildArtifactPresentation(rawHtml: string, kind: string | null | undefined): ArtifactPresentation {
  const html = buildSandboxedHtml(rawHtml)
  if (readArtifactKind(kind) !== "SLIDE_DECK") return { html }
  // A deck that does not split (no recognizable slide markup, or more than
  // MAX_SLIDES chunks) still yields one slide, so the slide UI and slide-anchored
  // comments behave the same whatever the author uploaded.
  const deck = parseSlideDeck(rawHtml)
  return {
    html,
    slides: deck.slides.map((slide) => ({
      index: slide.index,
      title: slide.title,
      description: slide.description,
      // Scale-to-fit is added here, at render time, so stored decks get it too.
      html: buildSandboxedHtml(withSlideFit(slide.html)),
    })),
  }
}

/** Slide index and labels only, for API callers that need to address a slide but not render it. */
export async function listArtifactSlides(blobPathname: string | null): Promise<Array<{ index: number; title: string | null; description: string | null }>> {
  if (!blobPathname) return []
  const bytes = await getArtifactStorage().get(blobPathname)
  if (!bytes) return []
  return parseSlideDeck(new TextDecoder().decode(bytes)).slides.map(({ index, title, description }) => ({ index, title, description }))
}
