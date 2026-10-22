import { describe, expect, it } from "vitest"
import { placeMenu, MENU_MARGIN } from "@/lib/spec-docs/menu-placement"

const inside = (p: ReturnType<typeof placeMenu>, h: number, vp: { width: number; height: number; offsetLeft?: number; offsetTop?: number }) => {
  const ox = vp.offsetLeft ?? 0, oy = vp.offsetTop ?? 0
  const height = Math.min(h, p.maxHeight)
  expect(p.left).toBeGreaterThanOrEqual(ox)
  expect(p.top).toBeGreaterThanOrEqual(oy)
  expect(p.left + p.width).toBeLessThanOrEqual(ox + vp.width)
  expect(p.top + height).toBeLessThanOrEqual(oy + vp.height)
}

describe("placeMenu", () => {
  const desktop = { width: 1280, height: 720 }
  it("opens below a caret near the top", () => {
    const p = placeMenu({ caret: { top: 100, bottom: 120, left: 200 }, viewport: desktop, menuHeight: 120 })
    expect(p.top).toBe(126)
    inside(p, 120, desktop)
  })
  it("flips above a caret near the bottom, never overlapping the caret line", () => {
    const p = placeMenu({ caret: { top: 680, bottom: 700, left: 200 }, viewport: desktop, menuHeight: 120 })
    expect(p.top + 120).toBeLessThanOrEqual(680 - 6)
    inside(p, 120, desktop)
  })
  it("pins and scrolls internally when it fits neither side", () => {
    const vp = { width: 390, height: 300 }
    const p = placeMenu({ caret: { top: 140, bottom: 160, left: 10 }, viewport: vp, menuHeight: 320 })
    expect(p.maxHeight).toBe(300 - 2 * MENU_MARGIN)
    expect(p.top).toBe(MENU_MARGIN)
    inside(p, 320, vp)
  })
  it("respects the visual viewport offset (on-screen keyboard)", () => {
    const vp = { width: 390, height: 320, offsetLeft: 0, offsetTop: 40 }
    const p = placeMenu({ caret: { top: 330, bottom: 350, left: 380 }, viewport: vp, menuHeight: 120 })
    inside(p, 120, vp)
    expect(p.top + 120).toBeLessThanOrEqual(330 - 6)
  })
  it("clamps horizontally on a narrow screen", () => {
    const p = placeMenu({ caret: { top: 100, bottom: 120, left: 380 }, viewport: { width: 390, height: 800 }, menuHeight: 100 })
    expect(p.width).toBe(320)
    expect(p.left + p.width).toBeLessThanOrEqual(390 - MENU_MARGIN)
  })
})
