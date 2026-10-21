#!/usr/bin/env node
/**
 * Chain graph renderer benchmark (design D3/D4 go/no-go). Drives /chain-graph-bench (synthetic data, no DB) in headless
 * Chromium and records frame times during real mouse-drag pan, wheel zoom across the semantic-zoom bands, a programmatic
 * viewport sweep, click-to-trace, and cluster expand. Not part of CI gating.
 *
 *   BENCH_URL=http://localhost:3123 PLAYWRIGHT=/path/to/node_modules/playwright node scripts/chain-graph-bench.mjs [1000 1500]
 *
 * Caveat: headless Chromium here rasterises in software (no GPU), so absolute fps is pessimistic versus a laptop; compare
 * the numbers against `next start` (production React) as well as `next dev`.
 */
import { pathToFileURL } from "node:url"

const base = process.env.BENCH_URL ?? "http://localhost:3123"
const playwrightPath = process.env.PLAYWRIGHT ?? "playwright"
const { chromium } = await import(playwrightPath.startsWith("/") ? pathToFileURL(`${playwrightPath}/index.mjs`).href : playwrightPath)
const sizes = process.argv.slice(2).map(Number).filter(Boolean)
if (sizes.length === 0) sizes.push(1000, 1500)

// Installed in the page: records rAF deltas between start() and stop().
const SAMPLER = `
  window.__frames = { last: 0, deltas: [], gen: 0 };
  window.__startFrames = () => { const f = window.__frames; const gen = ++f.gen; f.deltas = []; f.last = 0;
    const tick = (t) => { if (f.gen !== gen) return; if (f.last) f.deltas.push(t - f.last); f.last = t; requestAnimationFrame(tick) };
    requestAnimationFrame(tick) };
  window.__stopFrames = () => { window.__frames.gen++; return window.__frames.deltas };
`

function stats(deltas) {
  if (deltas.length === 0) return { frames: 0, fps: 0, p50: 0, p95: 0, max: 0, over33: 0 }
  const sorted = [...deltas].sort((a, b) => a - b)
  const total = deltas.reduce((s, d) => s + d, 0)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    frames: deltas.length,
    fps: Math.round((deltas.length / total) * 1000 * 10) / 10,
    p50: Math.round(q(0.5) * 10) / 10,
    p95: Math.round(q(0.95) * 10) / 10,
    max: Math.round(sorted[sorted.length - 1]),
    over33: Math.round((deltas.filter((d) => d > 33.4).length / deltas.length) * 100),
  }
}

async function measure(page, label, action) {
  await page.evaluate(() => window.__startFrames())
  const t0 = Date.now()
  await action()
  const wall = Date.now() - t0
  const deltas = await page.evaluate(() => window.__stopFrames())
  return { label, wallMs: wall, ...stats(deltas) }
}

const browser = await chromium.launch()
const results = []
for (const n of sizes) {
  for (const mode of ["none", "all"]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(SAMPLER)
    const loadStart = Date.now()
    await page.goto(`${base}/chain-graph-bench?n=${n}&collapsed=${mode}&limit=off`, { waitUntil: "load", timeout: 180000 })
    await page.waitForFunction(() => window.__chainGraphBench?.ready, null, { timeout: 120000 })
    await page.waitForSelector(".react-flow__viewport", { timeout: 30000 })
    await page.waitForTimeout(1500)
    const hooks = await page.evaluate(() => ({ nodes: window.__chainGraphBench.nodes, edges: window.__chainGraphBench.edges, layoutMs: window.__chainGraphBench.layoutMs }))
    const domNodes = await page.locator(".react-flow__node").count()
    const row = { n, mode: mode === "none" ? "expanded" : "collapsed", elements: hooks.nodes + hooks.edges, nodes: hooks.nodes, edges: hooks.edges, layoutMs: Math.round(hooks.layoutMs), loadToReadyMs: Date.now() - loadStart, domNodesAtFit: domNodes, runs: [] }

    const box = await page.locator('[data-testid="chain-graph-canvas"]').boundingBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    // Worst case for DOM cost: fit view, so every element is on screen (viewport culling removes nothing).
    row.runs.push(await measure(page, "mouse drag pan at fit view, all elements on screen (3s)", async () => {
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      for (let i = 0; i < 90; i++) {
        const a = (i / 90) * Math.PI * 4
        await page.mouse.move(cx + Math.cos(a) * 120, cy + Math.sin(a) * 80)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
    }))

    // Zoom in to the label band first so the pan is representative of working zoom, then pan with a real drag.
    await page.mouse.move(cx, cy)
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120)
    await page.waitForTimeout(500)
    row.runs.push(await measure(page, "mouse drag pan (3s)", async () => {
      await page.mouse.move(cx, cy)
      await page.mouse.down()
      const steps = 90
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 4
        await page.mouse.move(cx + Math.cos(a) * 200, cy + Math.sin(a) * 120)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
    }))
    row.runs.push(await measure(page, "wheel zoom through bands (3s)", async () => {
      for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, i < 20 ? 100 : -100); await page.waitForTimeout(40) }
      await page.waitForTimeout(200)
    }))
    row.runs.push(await measure(page, "viewport sweep, 120 frames", async () => {
      await page.evaluate(async () => {
        const b = window.__chainGraphBench
        await new Promise((resolve) => { let i = 0; const step = () => { b.setViewport(-i * 6, -i * 3, 0.4 + (i % 60) / 40); if (++i < 120) requestAnimationFrame(step); else resolve() }; step() })
      })
    }))
    const firstNode = await page.evaluate(() => document.querySelector(".react-flow__node")?.getAttribute("data-id"))
    if (firstNode) {
      const t = Date.now()
      await page.evaluate((k) => window.__chainGraphBench.select(k), firstNode)
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      row.traceToPaintMs = Date.now() - t
    }
    if (mode === "all") {
      const t = Date.now()
      await page.evaluate(() => window.__chainGraphBench.expandAll())
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      row.expandAllMs = Date.now() - t
    }
    results.push(row)
    await page.close()
  }
}
await browser.close()
console.log(JSON.stringify(results, null, 2))
