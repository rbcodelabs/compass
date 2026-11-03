/**
 * Search the signed-in user's Google Drive from the agent composer.
 *
 * Compass calls Google's hosted Drive MCP server (ADR-0018) server-side, with the user's own connector grant, so
 * there is no browser-side Google token, no Picker API key and no origin allowlist. The user only ever sees files
 * their own Google account can see. File text never reaches the browser: snippets are switched off and only the
 * ID, title and kind of each hit is returned.
 *
 * The response parser is deliberately tolerant. It was written from the published tool reference, not from a
 * live response, so it accepts the common shapes and drops anything that does not yield a valid file ID.
 */
import { McpConnectorError } from "@/lib/mcp-connectors/config"
import { callConnectorTool } from "@/lib/mcp-connectors/call"
import { GOOGLE_DRIVE_CONNECTOR_SLUG, googleResourceFromUrl, type GoogleResourceRef } from "@/lib/agent-google-resources"

export const DRIVE_SEARCH_MIN_CHARS = 2
export const DRIVE_SEARCH_MAX_CHARS = 100
export const DRIVE_SEARCH_PAGE_SIZE = 8

export type DriveSearchHit = GoogleResourceRef & { title: string }

const SQ = String.fromCharCode(39)
const BS = String.fromCharCode(92)

/** Escapes a user string for a single-quoted Drive query value. */
export function escapeDriveQueryValue(value: string): string {
  return value.split(BS).join(BS + BS).split(SQ).join(BS + SQ)
}

/** The query for a name search. The MCP reference calls the term title; the REST API calls it name. */
export function driveTitleQuery(term: string, field: "title" | "name" = "title"): string {
  return field + " contains " + SQ + escapeDriveQueryValue(term) + SQ
}

const MIME_URLS: Array<[string, string]> = [
  ["application/vnd.google-apps.document", "https://docs.google.com/document/d/"],
  ["application/vnd.google-apps.spreadsheet", "https://docs.google.com/spreadsheets/d/"],
  ["application/vnd.google-apps.presentation", "https://docs.google.com/presentation/d/"],
  ["application/vnd.google-apps.folder", "https://drive.google.com/drive/folders/"],
]

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["files", "results", "items"]) if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

/** Turns whatever the tool returned into validated hits. Never throws. */
export function parseDriveSearchResult(structured: unknown, text: string): DriveSearchHit[] {
  let list = asList(structured)
  if (!list.length && text) {
    try { list = asList(JSON.parse(text)) } catch { /* plain text: nothing usable */ }
  }
  const seen = new Set<string>()
  const hits: DriveSearchHit[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const row = entry as Record<string, unknown>
    const id = str(row.id) ?? str(row.fileId)
    if (!id) continue
    const mime = str(row.mimeType) ?? ""
    const base = MIME_URLS.find(([type]) => type === mime)?.[1] ?? "https://drive.google.com/file/d/"
    // Rebuilt from the ID and validated by the same strict parser a pasted link goes through.
    const ref = googleResourceFromUrl(base + encodeURIComponent(id))
    if (!ref || seen.has(ref.fileId)) continue
    seen.add(ref.fileId)
    hits.push({ ...ref, title: (str(row.title) ?? str(row.name) ?? ref.label).slice(0, 200) })
    if (hits.length >= DRIVE_SEARCH_PAGE_SIZE) break
  }
  return hits
}

export type DriveSearchOutcome =
  | { status: "ok"; hits: DriveSearchHit[] }
  | { status: "not_connected" }
  | { status: "unavailable" }

function isNotConnected(error: unknown): boolean {
  return error instanceof McpConnectorError && (error.code === "NOT_CONNECTED" || error.code === "GRANT_CHANGED")
}

export async function searchUserDrive(userId: string, term: string): Promise<DriveSearchOutcome> {
  const call = (field: "title" | "name") =>
    callConnectorTool({
      slug: GOOGLE_DRIVE_CONNECTOR_SLUG,
      userId,
      toolName: "search_files",
      args: { query: driveTitleQuery(term, field), pageSize: DRIVE_SEARCH_PAGE_SIZE, excludeContentSnippets: true },
    })
  try {
    let result
    try {
      result = await call("title")
    } catch (error) {
      // A rejected query term is a tool error, not a connection problem: try the REST spelling once.
      if (isNotConnected(error)) throw error
      result = await call("name")
    }
    return { status: "ok", hits: parseDriveSearchResult(result.structured, result.text) }
  } catch (error) {
    if (isNotConnected(error)) return { status: "not_connected" }
    console.warn("[agent-drive-search] search failed", error instanceof Error ? error.message : error)
    return { status: "unavailable" }
  }
}
