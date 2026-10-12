/**
 * Recognise Google Drive / Docs links so an external-link artifact can be shown
 * as what it is, with a read-only preview.
 *
 * WHY DERIVED, NOT STORED — the artifact keeps only the URL the user pasted. What
 * kind of Google file it is, and the URL to embed, are computed from that string
 * at render time. No column, no migration, and nothing to drift out of step with
 * the link. Compass never reads the file: the preview is Google's own viewer in
 * an iframe, authenticated by the *reader's* Google session, so somebody without
 * access to the file sees Google's sign-in or request-access page, not content.
 *
 * WHY A STRICT PARSER — the embed URL is built from the matched file ID only,
 * never by echoing the pasted string. An exact-host allowlist plus an ID shape
 * check means `https://docs.google.com.evil.example/...`, credentials in the URL,
 * or a crafted path cannot make the frame point anywhere but Google's viewer.
 */

export type GoogleDriveKind = "document" | "spreadsheet" | "presentation" | "form" | "file" | "folder"

export interface GoogleDriveLink {
  kind: GoogleDriveKind
  fileId: string
  /** Human label for the badge, e.g. "Google Doc". */
  label: string
  /**
   * The URL to put in an iframe, or null when previewing it in place would be
   * wrong. A Form is the case: its viewer is a live, submittable form, which is
   * not a read-only preview.
   */
  embedUrl: string | null
}

const LABELS: Record<GoogleDriveKind, string> = {
  document: "Google Doc",
  spreadsheet: "Google Sheet",
  presentation: "Google Slides",
  form: "Google Form",
  file: "Google Drive file",
  folder: "Google Drive folder",
}

/** Drive IDs are URL-safe base64-ish; 10 is below any real one and above path noise like "u". */
const ID = "([A-Za-z0-9_-]{10,})"

const DOCS_PATHS: Array<{ pattern: RegExp; kind: GoogleDriveKind; embed: (id: string) => string | null }> = [
  { pattern: new RegExp(`^/document/(?:u/\\d+/)?d/${ID}(?:/|$)`), kind: "document", embed: (id) => `https://docs.google.com/document/d/${id}/preview` },
  { pattern: new RegExp(`^/spreadsheets/(?:u/\\d+/)?d/${ID}(?:/|$)`), kind: "spreadsheet", embed: (id) => `https://docs.google.com/spreadsheets/d/${id}/preview` },
  { pattern: new RegExp(`^/presentation/(?:u/\\d+/)?d/${ID}(?:/|$)`), kind: "presentation", embed: (id) => `https://docs.google.com/presentation/d/${id}/preview` },
  // Published forms live at /forms/d/e/<id>/viewform; editor links at /forms/d/<id>/edit.
  { pattern: new RegExp(`^/forms/(?:u/\\d+/)?d/(?:e/)?${ID}(?:/|$)`), kind: "form", embed: () => null },
]

const DRIVE_PATHS: Array<{ pattern: RegExp; kind: GoogleDriveKind; embed: (id: string) => string }> = [
  { pattern: new RegExp(`^/file/(?:u/\\d+/)?d/${ID}(?:/|$)`), kind: "file", embed: (id) => `https://drive.google.com/file/d/${id}/preview` },
  { pattern: new RegExp(`^/drive/(?:u/\\d+/)?folders/${ID}(?:/|$)`), kind: "folder", embed: (id) => `https://drive.google.com/embeddedfolderview?id=${id}#list` },
]

/** `null` when the URL is not a recognisable Google Drive / Docs link. Never throws. */
export function parseGoogleDriveLink(value: string | null | undefined): GoogleDriveLink | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (url.username || url.password || url.port) return null

  const host = url.hostname.toLowerCase()
  const make = (kind: GoogleDriveKind, fileId: string, embedUrl: string | null): GoogleDriveLink => ({ kind, fileId, label: LABELS[kind], embedUrl })

  if (host === "docs.google.com") {
    for (const entry of DOCS_PATHS) {
      const match = entry.pattern.exec(url.pathname)
      if (match) return make(entry.kind, match[1], entry.embed(match[1]))
    }
    return null
  }

  if (host === "drive.google.com") {
    for (const entry of DRIVE_PATHS) {
      const match = entry.pattern.exec(url.pathname)
      if (match) return make(entry.kind, match[1], entry.embed(match[1]))
    }
    // Legacy share links: /open?id=<id> and /uc?id=<id>. The type is not in the URL.
    if (url.pathname === "/open" || url.pathname === "/uc") {
      const id = url.searchParams.get("id")
      if (id && new RegExp(`^${ID}$`).test(id)) return make("file", id, `https://drive.google.com/file/d/${id}/preview`)
    }
  }

  return null
}

export function isGoogleDriveUrl(value: string | null | undefined): boolean {
  return parseGoogleDriveLink(value) !== null
}
