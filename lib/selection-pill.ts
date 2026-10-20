// Pure helpers for the floating "selection pill" (components/selection-ask-pill.tsx).

/** A selection must be longer than this to be worth offering actions for. */
export const PILL_MIN_CHARS = 8

export const PILL_HEIGHT = 36
// Rough half-width of the pill; used to keep its centre on screen without a measure pass.
export const PILL_HALF_WIDTH = 100
const GAP = 8
const MARGIN = 8

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * Where to put the pill so it sits centred above the selection, flips below it
 * when there is no room above, and never leaves the viewport. `left` is the
 * pill's horizontal centre (the component translates it by -50%).
 */
export function pillPosition(rect: Box, viewport: { width: number; height: number }): { left: number; top: number } {
  const centre = (rect.left + rect.right) / 2
  const left = Math.min(Math.max(centre, PILL_HALF_WIDTH + MARGIN), Math.max(viewport.width - PILL_HALF_WIDTH - MARGIN, PILL_HALF_WIDTH + MARGIN))
  let top = rect.top - PILL_HEIGHT - GAP
  if (top < MARGIN) top = rect.bottom + GAP
  top = Math.min(top, viewport.height - PILL_HEIGHT - MARGIN)
  return { left, top: Math.max(top, MARGIN) }
}

const EXCLUDED_ANCESTORS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [data-selection-pill]'

/**
 * Whether the pill should be offered for this selection. Not inside a form
 * field, an editable region, a dialog (the palette itself included) or the
 * pill; and long enough to mean something.
 */
export function isPillSelection(selection: Selection | null, activeElement: Element | null): { text: string; rect: DOMRect } | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = selection.toString().trim()
  if (text.length <= PILL_MIN_CHARS) return null
  if (activeElement?.matches(EXCLUDED_ANCESTORS)) return null
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  const element = container instanceof Element ? container : container.parentElement
  if (!element || element.closest(EXCLUDED_ANCESTORS)) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { text, rect }
}

/** A search query (<= 100 chars, cut at a word boundary) derived from selected text. */
export function similarQuery(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trim()
}
