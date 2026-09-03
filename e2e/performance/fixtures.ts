import { test as base, expect } from "@playwright/test";

export const ROUTES = ["discovery", "roadmap", "capture", "tasks"] as const;
export type PerformanceRoute = (typeof ROUTES)[number];

export const test = base.extend<{ workspaceBase: string }>({
  workspaceBase: async ({}, use) => {
    const org = process.env.PERF_ORG_SLUG;
    const workspace = process.env.PERF_WORKSPACE_SLUG;
    if (!org || !workspace) throw new Error("PERF_ORG_SLUG and PERF_WORKSPACE_SLUG are required");
    await use(`/${org}/${workspace}`);
  },
});

export { expect };
