import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const violations = [
  { name: "native table", pattern: /<table(?:\s|>)/g, replacement: "components/ui/table" },
  { name: "native details", pattern: /<details(?:\s|>)/g, replacement: "components/ui/collapsible" },
  { name: "custom switch", pattern: /role=["']switch["']/g, replacement: "components/ui/switch" },
  { name: "native checkbox", pattern: /type=["']checkbox["']/g, replacement: "components/ui/checkbox" },
];

async function filesUnder(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return entry.name.endsWith(".tsx") ? [relative] : [];
  }));
  return files.flat();
}

const files = [...await filesUnder("app"), ...await filesUnder("components")]
  .filter((file) => !file.startsWith("components/ui/"));
const findings = [];

for (const file of files) {
  const lines = (await readFile(path.join(root, file), "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    for (const violation of violations) {
      violation.pattern.lastIndex = 0;
      if (violation.pattern.test(line)) {
        findings.push(`${file}:${index + 1} ${violation.name}; use ${violation.replacement}`);
      }
    }
  }
}

if (findings.length) {
  console.error("Custom generic controls found:");
  findings.forEach((finding) => console.error(`  ${finding}`));
  process.exit(1);
}

console.log("UI primitive guard passed. Generic controls use shared shadcn primitives.");
