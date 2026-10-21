/**
 * Pass-through doubles for lib/work-item-resolve.ts and lib/work-item-page.ts, for suites that drive a page or
 * route with a hand-rolled Prisma fake and assert on the UUID queries it makes. Every reference resolves to
 * itself, un-numbered, so no redirect happens. The resolver is covered by __tests__/work-item-resolve.test.ts and
 * the page/route behaviour (display IDs, 308, 404) by the page tests that use the real one.
 *
 *   vi.mock("@/lib/work-item-resolve", async () => (await import("./helpers/work-item-resolve-mock")).workItemResolveMock())
 *   vi.mock("@/lib/work-item-page", async () => (await import("./helpers/work-item-resolve-mock")).workItemPageMock())
 */
const passthrough = (type: string, ref: string) => ({ ok: true as const, type, id: ref, displayId: null, canonical: ref })

export function workItemResolveMock() {
  return {
    resolveWorkItem: async (_db: unknown, _workspaceId: string, type: string, ref: string) => passthrough(type, ref),
    resolveWorkItemId: async (_db: unknown, _workspaceId: string, _type: string, ref: string) => ref,
    resolveDisplayId: async () => ({ ok: false as const, reason: "invalid" as const, message: "not supported in this test" }),
    canonicalRedirectSegment: () => null,
  }
}

export function workItemPageMock() {
  return {
    resolveWorkItemPage: async (args: { type: string; param: string }) => passthrough(args.type, args.param),
  }
}
