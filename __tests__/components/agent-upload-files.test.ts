import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_UPLOADS, UPLOAD_MAX_BYTES, uploadAgentFiles } from "@/components/agent/composer/attach-menu"

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name)

afterEach(() => vi.unstubAllGlobals())

describe("uploadAgentFiles (attach button + drag-and-drop)", () => {
  it("uploads each file and reports it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ref: "r/a.png", name: "a.png", size: 10 }), { status: 200 })))
    const onUploaded = vi.fn(); const onError = vi.fn()
    await uploadAgentFiles({ files: [file("a.png"), file("b.png")], workspaceId: "ws", uploadCount: 0, onUploaded, onError })
    expect(onUploaded).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
  })

  it("rejects oversize files without calling the network", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock)
    const onError = vi.fn()
    await uploadAgentFiles({ files: [file("big.bin", UPLOAD_MAX_BYTES + 1)], workspaceId: "ws", uploadCount: 0, onUploaded: vi.fn(), onError })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("big.bin"))
  })

  it("stops at the per-message cap", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock)
    const onError = vi.fn()
    await uploadAgentFiles({ files: [file("a.txt")], workspaceId: "ws", uploadCount: MAX_UPLOADS, onUploaded: vi.fn(), onError })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
  })

  it("reports a server error and keeps going", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 400 })))
    const onError = vi.fn()
    await uploadAgentFiles({ files: [file("a.txt")], workspaceId: "ws", uploadCount: 0, onUploaded: vi.fn(), onError })
    expect(onError).toHaveBeenCalledWith("nope")
  })
})
