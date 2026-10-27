/**
 * Worker image upload (lib/agent-image-callback.ts).
 *
 * Same boundary as the transcript upload: a bearer-shaped token authenticated before the
 * body is read, a size cap that does not trust content-length, tenant scope from the run
 * row, and — specific to images — the type decided by magic bytes, not by the caller.
 */
import { describe, it, expect, vi } from "vitest"

import { handleAgentImageUpload, sniffImageType } from "@/lib/agent-image-callback"
import { DOC_IMAGE_MAX_BYTES } from "@/lib/doc-images"
import { agentRunSandboxName, hashAgentRunWorkerToken } from "@/lib/agent-runs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const WS = "22222222-2222-4222-8222-222222222222"
const TOKEN = "t".repeat(43)
const URL_BASE = `https://c.test/api/internal/agent/runs/${RUN_ID}/images`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    conversationId: "33333333-3333-4333-8333-333333333333",
    workspaceId: WS,
    userId: "user-1",
    status: "RUNNING",
    kind: "CHAT",
    claimId: null,
    apiKeyId: "key-1",
    sandboxName: agentRunSandboxName(RUN_ID),
    packProvenance: "[]",
    workerTokenHash: hashAgentRunWorkerToken(TOKEN),
    deadlineAt: new Date(Date.now() + 600_000),
    lastSeq: 0,
    eventCount: 0,
    payloadBytes: 0,
    createdAt: new Date(5_000),
    ...overrides,
  }
}

function harness(row = runRow()) {
  const prisma: Any = { agentRun: { findUnique: vi.fn().mockResolvedValue(row) } }
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const storage = () => ({
    put: vi.fn(async (key: string, bytes: Uint8Array, contentType?: string) => {
      objects.set(key, { bytes, contentType })
      return { pathname: key }
    }),
  })
  return { prisma, objects, storage }
}

function upload(body: BodyInit | null = PNG as Any, { token = TOKEN as string | null, url = URL_BASE, headers = {} as Record<string, string> } = {}) {
  return new Request(url, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "image/png", ...headers },
    body,
  })
}

describe("sniffImageType", () => {
  it("recognises the four served formats and nothing else", () => {
    expect(sniffImageType(PNG)).toBe("image/png")
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif")
    expect(
      sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp")
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode("<html><script>alert(1)</script>"))).toBeNull()
    expect(sniffImageType(new Uint8Array([]))).toBeNull()
  })
})

describe("handleAgentImageUpload", () => {
  it("stores the image under the run's workspace and returns a same-origin markdown URL", async () => {
    const h = harness()
    const res = await handleAgentImageUpload(upload(PNG as Any, { headers: { "x-agent-image-name": "page.png" } }), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toMatch(new RegExp(`^/api/docs/images/${WS}/[0-9a-f-]{36}\\.png$`))
    expect(body.markdown).toBe(`![page.png](${body.url})`)
    const [[key, stored]] = [...h.objects.entries()]
    expect(key).toMatch(new RegExp(`^docs/${WS}/images/[0-9a-f-]{36}\\.png$`))
    expect(stored.contentType).toBe("image/png")
  })

  it("ignores a lying content-type: the sniffed type decides the extension", async () => {
    const h = harness()
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
    const res = await handleAgentImageUpload(upload(jpeg as Any), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(200)
    expect((await res.json()).url).toMatch(/\.jpg$/)
  })

  it("rejects non-image bytes, including SVG and HTML", async () => {
    const h = harness()
    const res = await handleAgentImageUpload(upload(new TextEncoder().encode("<svg/>") as Any), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(415)
    expect(h.objects.size).toBe(0)
  })

  it("strips markdown-breaking characters and paths from the filename", async () => {
    const h = harness()
    const res = await handleAgentImageUpload(
      upload(PNG as Any, { headers: { "x-agent-image-name": "../../etc/a](javascript:x).png" } }),
      RUN_ID,
      h.prisma,
      h.storage,
    )
    const { markdown } = await res.json()
    expect(markdown).toMatch(/^!\[[^\]()<>/\\]*\]\(\/api\/docs\/images\//)
  })

  it("requires a bearer token and does not read the body first", async () => {
    const h = harness()
    const res = await handleAgentImageUpload(upload(PNG as Any, { token: null }), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(401)
    expect(h.prisma.agentRun.findUnique).not.toHaveBeenCalled()
  })

  it("rejects a wrong token", async () => {
    const h = harness()
    const res = await handleAgentImageUpload(upload(PNG as Any, { token: "x".repeat(43) }), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(401)
    expect(h.objects.size).toBe(0)
  })

  it("rejects a terminal run, whose token is no longer bound", async () => {
    const h = harness(runRow({ status: "SUCCEEDED" }))
    const res = await handleAgentImageUpload(upload(), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(401)
  })

  it("rejects non-chat runs", async () => {
    const h = harness(runRow({ kind: "HANDOFF" }))
    const res = await handleAgentImageUpload(upload(), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(409)
  })

  it("rejects an oversized body even when content-length is absent or wrong", async () => {
    const h = harness()
    const big = new Uint8Array(DOC_IMAGE_MAX_BYTES + 1)
    big.set(PNG)
    const res = await handleAgentImageUpload(upload(big as Any), RUN_ID, h.prisma, h.storage)
    expect(res.status).toBe(413)
    expect(h.objects.size).toBe(0)
  })

  it("rejects a query string and a malformed run id", async () => {
    const h = harness()
    expect((await handleAgentImageUpload(upload(PNG as Any, { url: `${URL_BASE}?x=1` }), RUN_ID, h.prisma, h.storage)).status).toBe(400)
    expect((await handleAgentImageUpload(upload(), "not-a-uuid", h.prisma, h.storage)).status).toBe(400)
  })
})
