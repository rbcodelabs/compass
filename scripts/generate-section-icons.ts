#!/usr/bin/env node
// Generates a per-section favicon (white lucide glyph on the brand indigo tile)
// at app/[orgSlug]/[workspaceSlug]/<section>/icon.svg. Next.js serves each as
// that route segment's <link rel="icon">. Usage: node scripts/generate-section-icons.ts
import { readFileSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"

const SECTIONS: Record<string, string> = {
  home: "house",
  updates: "clock-3",
  capture: "message-square",
  feedback: "message-square",
  okrs: "target",
  discovery: "lightbulb",
  solutions: "puzzle",
  experiments: "flask-conical",
  roadmap: "map",
  metrics: "chart-column",
  tasks: "list-checks",
  decisions: "message-square-check",
  docs: "book-open",
  canvas: "waypoints",
  agent: "sparkles",
  "card-sort": "layout-grid",
  reviews: "clipboard-check",
  notifications: "bell",
  settings: "settings",
}

const lucideRoot = dirname(realpathSync(join("node_modules/lucide-react/package.json")))
const attrs = (a: Record<string, string>) =>
  Object.entries(a).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")

for (const [section, icon] of Object.entries(SECTIONS)) {
  const src = readFileSync(join(lucideRoot, "dist/esm/icons", `${icon}.mjs`), "utf8")
  const m = src.match(/const __iconNode = (\[[\s\S]*?\]);\n/)
  if (!m) throw new Error(`no icon node for ${icon}`)
  const nodes = (0, eval)(m[1]) as [string, Record<string, string>][]
  const body = nodes.map(([tag, a]) => `    <${tag} ${attrs(a)}/>`).join("\n")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#5B3DF5"/>
  <g transform="translate(6 6) scale(0.8333)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
${body}
  </g>
</svg>
`
  writeFileSync(`app/[orgSlug]/[workspaceSlug]/${section}/icon.svg`, svg)
  console.log(section, "<-", icon)
}
