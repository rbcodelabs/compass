import { afterEach, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ bytes: new Map<string, Uint8Array>(), inventory: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@/lib/db", () => ({ default: () => ({ docStorageObject: { create: state.inventory } }) }))
vi.mock("@rbcodelabs/geode-headless/catalog/cloud", async importOriginal => {
  const actual = await importOriginal<typeof import("@rbcodelabs/geode-headless/catalog/cloud")>()
  return { ...actual, createPrivateBlobStore: (options: Parameters<typeof actual.createPrivateBlobStore>[0]) => actual.createPrivateBlobStore({ ...options, sdk: {
    put: vi.fn(async (pathname: string, bytes: Uint8Array) => {
      expect(state.inventory).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pathname }) }))
      state.bytes.set(pathname, bytes)
      return { pathname }
    }),
    get: vi.fn(async (pathname: string) => {
      const bytes = state.bytes.get(pathname)
      if (!bytes) return null
      return { statusCode: 200, blob: { pathname }, headers: new Headers({ "content-length": String(bytes.byteLength) }), stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
    }),
    del: vi.fn(), list: vi.fn(),
  } as unknown as NonNullable<Parameters<typeof actual.createPrivateBlobStore>[0]["sdk"]> }) }
})
afterEach(() => vi.unstubAllEnvs())

it("round trips through the real SDK private Blob adapter with valid prefix and retry budgets", async () => {
  vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace-a")
  vi.stubEnv("VERCEL_ENV", "preview")
  vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "1")
  vi.stubEnv("VERCEL_GIT_PULL_REQUEST_ID", "123")
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40))
  vi.stubEnv("GEODE_DOCS_LOCAL_ROOT", "")
  vi.stubEnv("GEODE_DOCS_BLOB_TOKEN", "synthetic-test-token")
  const { documentBlobPrefix, getDocumentStore } = await import("@/lib/document-storage")
  vi.stubEnv("GEODE_DOCS_BLOB_PREFIX", documentBlobPrefix("workspace-a"))
  const store = await getDocumentStore("workspace-a")
  const written = await store.putContent("\uFEFF  hello 日本語\n")
  expect(written.status).toBe("ok")
  if (written.status !== "ok") throw new Error(written.status)
  expect(await store.readContent(written.reference)).toEqual({ status: "ok", text: "\uFEFF  hello 日本語\n" })
  expect(state.inventory).toHaveBeenCalledOnce()
})
