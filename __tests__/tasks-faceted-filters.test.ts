import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Tasks faceted filters", () => {
  it("adapts squad, assignee, and priority to the shared filter menu", () => {
    const adapter = source("components/tasks/tasks-filters.tsx");

    expect(adapter).toContain('label: "Squad"');
    expect(adapter).toContain('label: "Assignee"');
    expect(adapter).toContain('label: "Priority"');
    expect(adapter).toContain("color: squad.color");
    expect(adapter).toContain('setFilter("squad", value)');
    expect(adapter).toContain('setFilter("assignee", value)');
    expect(adapter).toContain('setFilter("priority", value)');
    expect(adapter).toContain("params.set(key, value)");
    expect(adapter).toContain("onClearAll={clearAll}");
  });

  it("clears all three task filters atomically while preserving unrelated query parameters", () => {
    const adapter = source("components/tasks/tasks-filters.tsx");
    const clearAll = adapter.slice(adapter.indexOf("function clearAll"), adapter.indexOf("return ("));

    expect(clearAll).toContain('params.delete("squad")');
    expect(clearAll).toContain('params.delete("assignee")');
    expect(clearAll).toContain('params.delete("priority")');
    expect(clearAll.match(/router\.push/g)).toHaveLength(1);
    expect(clearAll).toContain("new URLSearchParams(searchParams.toString())");
  });
});
