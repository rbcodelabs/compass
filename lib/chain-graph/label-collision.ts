/**
 * Label collision culling for the chain graph's label and full zoom bands. Pure and renderer-agnostic so it is unit-tested.
 *
 * Node spacing from the force layout only accounts for dot radius, so showing every label at once overprints them. Instead
 * the view keeps a label only when its screen-space box does not collide with an already-kept, higher-priority label.
 * Dots and shapes always stay. Labels render at a constant screen size (counter-scaled by 1/zoom), so zooming in grows the
 * gaps between them in screen space and reveals more labels.
 */

export type LabelCandidate = {
  key: string
  /** Lower wins. See LABEL_TIER. */
  tier: number
  /** Kept regardless of collisions (selected, hovered, traced). They still occupy space, so lower tiers yield to them. */
  alwaysShow: boolean
  /** Screen-space box (CSS px) of the rendered label. */
  x: number
  y: number
  width: number
  height: number
}

/** Priority tiers, highest priority first. */
export const LABEL_TIER = { selected: 0, hovered: 1, traced: 2, match: 3, pinned: 4, key: 5, rest: 6 } as const
export const ALWAYS_SHOW_TIER_MAX = LABEL_TIER.traced

/** Gap kept between two shown labels, in screen px. */
const LABEL_GAP = 2

/** Rough text metrics of the label markup: text-xs / text-[10px] medium-weight sans, px-1, leading-tight, max-w-[200px]. */
const TITLE_CHAR_PX = 6.4
const DETAIL_CHAR_PX = 5.6
const LABEL_PAD_X = 8
const TITLE_LINE_PX = 15
const DETAIL_LINE_PX = 12.5
export const LABEL_MAX_TEXT_WIDTH = 200

export function estimateLabelSize(title: string, detail: string | null): { width: number; height: number } {
  const titleW = Math.min(LABEL_MAX_TEXT_WIDTH, Math.ceil(title.length * TITLE_CHAR_PX))
  const detailW = detail ? Math.min(LABEL_MAX_TEXT_WIDTH, Math.ceil(detail.length * DETAIL_CHAR_PX)) : 0
  return { width: Math.max(titleW, detailW) + LABEL_PAD_X, height: TITLE_LINE_PX + (detail ? DETAIL_LINE_PX : 0) }
}

export function labelTier(flags: { selected: boolean; hovered: boolean; traced: boolean; matched: boolean; pinned: boolean; keyType: boolean }): number {
  if (flags.selected) return LABEL_TIER.selected
  if (flags.hovered) return LABEL_TIER.hovered
  if (flags.traced) return LABEL_TIER.traced
  if (flags.matched) return LABEL_TIER.match
  if (flags.pinned) return LABEL_TIER.pinned
  return flags.keyType ? LABEL_TIER.key : LABEL_TIER.rest
}

function overlaps(a: LabelCandidate, b: LabelCandidate): boolean {
  return a.x < b.x + b.width + LABEL_GAP && b.x < a.x + a.width + LABEL_GAP && a.y < b.y + b.height + LABEL_GAP && b.y < a.y + a.height + LABEL_GAP
}

const CELL = 128

/** Keys of the labels to show. Deterministic: ordered by tier, then key. Always-show labels are kept even when they collide. */
export function resolveLabelCollisions(candidates: readonly LabelCandidate[]): Set<string> {
  const ordered = [...candidates].sort((a, b) => a.tier - b.tier || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const shown = new Set<string>()
  const grid = new Map<string, LabelCandidate[]>()
  const cellsOf = (c: LabelCandidate): string[] => {
    const out: string[] = []
    const x0 = Math.floor((c.x - LABEL_GAP) / CELL)
    const x1 = Math.floor((c.x + c.width + LABEL_GAP) / CELL)
    const y0 = Math.floor((c.y - LABEL_GAP) / CELL)
    const y1 = Math.floor((c.y + c.height + LABEL_GAP) / CELL)
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) out.push(`${gx},${gy}`)
    return out
  }

  const insert = (box: LabelCandidate) => {
    for (const cell of cellsOf(box)) {
      const bucket = grid.get(cell)
      if (bucket) bucket.push(box)
      else grid.set(cell, [box])
    }
  }
  for (const c of ordered) {
    const blocked = !c.alwaysShow && cellsOf(c).some((cell) => grid.get(cell)?.some((placed) => overlaps(c, placed)))
    if (blocked) continue
    shown.add(c.key)
    insert(c)
  }
  return shown
}
