import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user" } }) }));
const workspace = { id: "3eaf938a-782c-4073-a452-070d54156896" };
vi.mock("@/lib/db", () => ({ default: () => new Proxy({}, { get: (_, name) => name === "workspace" ? { findFirst: async () => workspace } : { findMany: async () => [] } }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/components/roadmap/roadmap-board", () => ({ RoadmapBoard: () => null }));
vi.mock("@/components/roadmap/native-timeline/native-timeline", () => ({ NativeTimeline: () => null }));
vi.mock("@/components/roadmap/roadmap-filters", () => ({ RoadmapFilters: () => null }));
vi.mock("@/components/roadmap/roadmap-view-toggle", () => ({ RoadmapViewToggle: () => null }));
import Page from "@/app/[orgSlug]/[workspaceSlug]/roadmap/page";
import { NativeTimeline } from "@/components/roadmap/native-timeline/native-timeline";
import { RoadmapBoard } from "@/components/roadmap/roadmap-board";
function find(node: unknown, type: unknown): ReactElement | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
  const element = node as ReactElement<{ children?: unknown }>;
  if (element.type === type) return element;
  return find(element.props?.children, type);
}
const render = (query = {}, orgSlug = "rbcodelabs", workspaceSlug = "compass") => Page({ params: Promise.resolve({ orgSlug, workspaceSlug }), searchParams: Promise.resolve(query) });
describe("native timeline default", () => {
  it("routes the workspace timeline to native and remounts only when squad changes", async () => {
    const first = find(await render({ view: "timeline" }), NativeTimeline);
    expect(first).toBeDefined();
    expect(find(await render({ view: "timeline" }), NativeTimeline)?.key).toBe(first?.key);
    expect(find(await render({ view: "timeline", squad: "squad-2" }), NativeTimeline)?.key).not.toBe(first?.key);
    expect(find(await render({ view: "timeline", squad: "all" }), NativeTimeline)?.key).not.toBe(first?.key);
  });
  it("keeps Board the default", async () => { expect(find(await render(), RoadmapBoard)).toBeDefined(); });
  it("renders native for old classic bookmarks", async () => { expect(find(await render({ view: "timeline", timelineEngine: "classic" }), NativeTimeline)).toBeDefined(); });
  it("renders native in every workspace without an opt-in parameter", async () => {
    workspace.id = "other-workspace";
    try { expect(find(await render({ view: "timeline" }, "another-org", "another-workspace"), NativeTimeline)).toBeDefined(); }
    finally { workspace.id = "3eaf938a-782c-4073-a452-070d54156896"; }
  });
});
