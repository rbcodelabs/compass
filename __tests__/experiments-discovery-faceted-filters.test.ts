import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe.each([
  ["Experiments", "components/experiments/experiments-filters.tsx"],
  ["Discovery", "components/discovery/discovery-filters.tsx"],
])("%s faceted filters", (_name, path) => {
  it("adapts squads to the shared filter menu", () => {
    const adapter = source(path);

    expect(adapter).toContain('label: "Squad"');
    expect(adapter).toContain("color: squad.color");
    expect(adapter).toContain('params.set("squad", value)');
    expect(adapter).toContain("onClearAll={clearAll}");
  });

  it("clears squad atomically while preserving unrelated query parameters", () => {
    const adapter = source(path);
    const clearAll = adapter.slice(adapter.indexOf("function clearAll"), adapter.indexOf("if (squads.length"));

    expect(clearAll).toContain("new URLSearchParams(searchParams.toString())");
    expect(clearAll).toContain('params.delete("squad")');
    expect(clearAll.match(/router\.push/g)).toHaveLength(1);
    expect(clearAll).not.toContain('params.delete("assumptionId")');
  });
});
