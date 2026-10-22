/**
 * Where the spec editor's "/" menu goes (spec docs phase 4). Pure: coordinates in, a box out.
 *
 * The menu is position:fixed, so it never takes space in the document. It prefers to open just below the caret line; if it would hang off the
 * bottom of the VISIBLE viewport (which shrinks under an on-screen keyboard) it flips above the caret; if it fits on neither side it is
 * pinned inside the viewport and scrolls internally. It never overlaps the caret line when it has a side to flip to.
 */
export const MENU_MARGIN = 8
export const MENU_GAP = 6
export const MENU_MAX_WIDTH = 320
/** Used before the menu has been measured; matches the menu's own max-height cap. */
export const MENU_ASSUMED_HEIGHT = 320

export type MenuViewport = { width: number; height: number; offsetLeft?: number; offsetTop?: number }
export type MenuPlacement = { top: number; left: number; width: number; maxHeight: number }

export function placeMenu(input: { caret: { top: number; bottom: number; left: number }; viewport: MenuViewport; menuHeight: number }): MenuPlacement {
  const { caret, viewport } = input
  const ox = viewport.offsetLeft ?? 0
  const oy = viewport.offsetTop ?? 0
  const width = Math.max(0, Math.min(MENU_MAX_WIDTH, viewport.width - MENU_MARGIN * 2))
  const left = Math.min(Math.max(caret.left, ox + MENU_MARGIN), ox + viewport.width - width - MENU_MARGIN)

  const available = Math.max(0, viewport.height - MENU_MARGIN * 2)
  const maxHeight = Math.min(MENU_ASSUMED_HEIGHT, available)
  const height = Math.min(input.menuHeight > 0 ? input.menuHeight : MENU_ASSUMED_HEIGHT, maxHeight)

  const topEdge = oy + MENU_MARGIN
  const bottomEdge = oy + viewport.height - MENU_MARGIN
  const below = caret.bottom + MENU_GAP
  if (below + height <= bottomEdge) return { top: Math.max(below, topEdge), left, width, maxHeight }
  const above = caret.top - MENU_GAP - height
  if (above >= topEdge) return { top: above, left, width, maxHeight }
  return { top: Math.max(topEdge, bottomEdge - height), left, width, maxHeight }
}
