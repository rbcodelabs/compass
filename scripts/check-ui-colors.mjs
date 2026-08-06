import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const baselinePath = path.join(root, "docs/design/raw-color-baseline.json");
const rawColor = /\b(?:bg|text|border|ring|outline|decoration|divide|shadow|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\/[0-9]{1,3})?\b/g;

// These surfaces intentionally own literal color: marketing/docs prose,
// brand previews, and data visualizations. Product chrome is not exempt.
const excludedPrefixes = [
  "app/(marketing)/",
  "app/help/",
  "components/branding/",
  "components/canvas/",
  "components/ui-registry.tsx",
];

async function filesUnder(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : [];
  }));
  return files.flat();
}

async function inventory() {
  const files = [...await filesUnder("app"), ...await filesUnder("components")]
    .filter((file) => !excludedPrefixes.some((prefix) => file.startsWith(prefix)))
    .sort();
  const occurrences = {};

  for (const file of files) {
    const lines = (await readFile(path.join(root, file), "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.includes("ui-color-allow")) continue;
      for (const match of line.matchAll(rawColor)) {
        const key = `${file}::${match[0]}`;
        occurrences[key] ??= [];
        occurrences[key].push(index + 1);
      }
    }
  }

  return occurrences;
}

const current = await inventory();

if (process.argv.includes("--write-baseline")) {
  const counts = Object.fromEntries(Object.entries(current).map(([key, lines]) => [key, lines.length]));
  await writeFile(baselinePath, `${JSON.stringify({ version: 1, counts }, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(counts).length} raw-color signatures to ${path.relative(root, baselinePath)}.`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(baselinePath, "utf8"));
} catch {
  console.error(`Missing or invalid baseline: ${path.relative(root, baselinePath)}`);
  console.error("Run `pnpm ui:colors:baseline` after reviewing all current occurrences.");
  process.exit(1);
}

const additions = [];
for (const [key, lines] of Object.entries(current)) {
  const allowedCount = baseline.counts[key] ?? 0;
  if (lines.length <= allowedCount) continue;
  const separator = key.lastIndexOf("::");
  const file = key.slice(0, separator);
  const token = key.slice(separator + 2);
  for (const line of lines.slice(allowedCount)) additions.push(`${file}:${line}  ${token}`);
}

if (additions.length > 0) {
  console.error("New raw Tailwind palette utilities found in product UI:");
  for (const addition of additions) console.error(`  ${addition}`);
  console.error("Use a semantic token, or add an inline `ui-color-allow` comment for a documented domain color.");
  process.exit(1);
}

const remaining = Object.values(current).reduce((total, lines) => total + lines.length, 0);
console.log(`UI color guard passed. ${remaining} baselined raw-color occurrences remain for incremental cleanup.`);
