import { describe, expect, it, vi, beforeEach } from "vitest"

const callConnectorTool = vi.fn()
vi.mock("@/lib/mcp-connectors/call", () => ({ callConnectorTool: (...args: unknown[]) => callConnectorTool(...args) }))

import { McpConnectorError } from "@/lib/mcp-connectors/config"
import { allowDriveSearch, DRIVE_SEARCH_MAX_PER_WINDOW, DRIVE_SEARCH_WINDOW_MS, driveTitleQuery, escapeDriveQueryValue, parseDriveSearchResult, searchUserDrive } from "@/lib/agent-drive-search"

const DOC_ID = "1AbCdEfGhIjKlMnOp"

describe("drive query", () => {
  it("quotes the term and escapes quotes and backslashes so it cannot break out", () => {
    expect(driveTitleQuery("roadmap")).toBe("title contains 'roadmap'")
    expect(driveTitleQuery("roadmap", "name")).toBe("name contains 'roadmap'")
    expect(escapeDriveQueryValue("it's")).toBe("it\\'s")
    expect(escapeDriveQueryValue("a\\b")).toBe("a\\\\b")
    expect(driveTitleQuery("x' or trashed = false or title contains 'y")).toBe("title contains 'x\\' or trashed = false or title contains \\'y'")
  })
})

describe("parseDriveSearchResult", () => {
  it("accepts a files array, a bare array, and JSON text", () => {
    const row = { id: DOC_ID, title: "Q4 plan", mimeType: "application/vnd.google-apps.document" }
    for (const [structured, text] of [[{ files: [row] }, ""], [[row], ""], [null, JSON.stringify({ results: [row] })]] as const) {
      const [hit] = parseDriveSearchResult(structured, text)
      expect(hit).toMatchObject({ fileId: DOC_ID, kind: "document", title: "Q4 plan", url: "https://docs.google.com/document/d/" + DOC_ID })
    }
  })

  it("maps mime types to kinds and falls back to a plain Drive file", () => {
    const hits = parseDriveSearchResult({ files: [
      { fileId: "SheetIdSheetId1", name: "Numbers", mimeType: "application/vnd.google-apps.spreadsheet" },
      { id: "FolderIdFolder12", name: "Stuff", mimeType: "application/vnd.google-apps.folder" },
      { id: "PdfIdPdfIdPdf12", name: "a.pdf", mimeType: "application/pdf" },
    ] }, "")
    expect(hits.map((h) => h.kind)).toEqual(["spreadsheet", "folder", "file"])
  })

  it("drops rows without a valid ID, dedupes, and never throws on junk", () => {
    expect(parseDriveSearchResult({ files: [{ id: "x" }, { title: "no id" }, null, 5, { id: DOC_ID }, { id: DOC_ID }, { id: "../../evil/path_____" }] }, "")).toHaveLength(1)
    expect(parseDriveSearchResult("nope", "not json")).toEqual([])
    expect(parseDriveSearchResult(undefined, "")).toEqual([])
  })

  it("returns only id, kind, label, url and title: nothing that could carry file text", () => {
    const [hit] = parseDriveSearchResult({ files: [{ id: DOC_ID, title: "T", snippet: "secret body", content: "more" }] }, "")
    expect(Object.keys(hit).sort()).toEqual(["fileId", "kind", "label", "title", "url"])
  })
})

describe("searchUserDrive", () => {
  beforeEach(() => { callConnectorTool.mockReset(); callConnectorTool.mockResolvedValue({ structured: null, text: "" }) })

  it("asks for no content snippets and returns hits", async () => {
    callConnectorTool.mockResolvedValue({ structured: { files: [{ id: DOC_ID, title: "Plan" }] }, text: "" })
    const out = await searchUserDrive("u1", "plan")
    expect(out).toMatchObject({ status: "ok", hits: [{ fileId: DOC_ID }] })
    expect(callConnectorTool).toHaveBeenCalledWith(expect.objectContaining({ slug: "google-drive", userId: "u1", toolName: "search_files", args: expect.objectContaining({ excludeContentSnippets: true }) }))
  })

  it("retries once with the REST spelling when the title term is rejected", async () => {
    callConnectorTool.mockRejectedValueOnce(new McpConnectorError("GATEWAY_FAILED", "bad term")).mockResolvedValueOnce({ structured: { files: [] }, text: "" })
    expect(await searchUserDrive("u1", "plan")).toEqual({ status: "ok", hits: [] })
    expect(callConnectorTool.mock.calls[1][0].args.query).toBe("name contains 'plan'")
  })

  it("does not retry a timeout (it would outlast the route's maxDuration)", async () => {
    callConnectorTool.mockImplementation(async () => { throw new McpConnectorError("GATEWAY_TIMEOUT") })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await searchUserDrive("u1", "plan")).toEqual({ status: "unavailable" })
    expect(callConnectorTool).toHaveBeenCalledTimes(1)
  })

  it("reports not connected without retrying", async () => {
    callConnectorTool.mockImplementation(async () => { throw new McpConnectorError("NOT_CONNECTED") })
    expect(await searchUserDrive("u1", "plan")).toEqual({ status: "not_connected" })
    expect(callConnectorTool).toHaveBeenCalledTimes(1)
  })

  it("degrades to unavailable on any other failure", async () => {
    callConnectorTool.mockImplementation(async () => { throw new Error("boom") })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await searchUserDrive("u1", "plan")).toEqual({ status: "unavailable" })
  })
})

describe("allowDriveSearch", () => {
  it("allows a bounded number per user per window, then recovers", () => {
    const t0 = 1_000_000
    for (let i = 0; i < DRIVE_SEARCH_MAX_PER_WINDOW; i++) expect(allowDriveSearch("rate-u", t0 + i)).toBe(true)
    expect(allowDriveSearch("rate-u", t0 + 100)).toBe(false)
    expect(allowDriveSearch("other-user", t0 + 100)).toBe(true)
    expect(allowDriveSearch("rate-u", t0 + DRIVE_SEARCH_WINDOW_MS + DRIVE_SEARCH_MAX_PER_WINDOW)).toBe(true)
  })
})
