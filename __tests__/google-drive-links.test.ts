import { describe, expect, it } from "vitest"
import { isGoogleDriveUrl, parseGoogleDriveLink } from "@/lib/google-drive-links"

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-"

describe("parseGoogleDriveLink", () => {
  it.each([
    [`https://docs.google.com/document/d/${ID}/edit`, "document", `https://docs.google.com/document/d/${ID}/preview`],
    [`https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.abc`, "document", `https://docs.google.com/document/d/${ID}/preview`],
    [`https://docs.google.com/document/u/0/d/${ID}/edit`, "document", `https://docs.google.com/document/d/${ID}/preview`],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, "spreadsheet", `https://docs.google.com/spreadsheets/d/${ID}/preview`],
    [`https://docs.google.com/presentation/d/${ID}/edit?usp=sharing`, "presentation", `https://docs.google.com/presentation/d/${ID}/preview`],
    [`https://drive.google.com/file/d/${ID}/view?usp=drive_link`, "file", `https://drive.google.com/file/d/${ID}/preview`],
    [`https://drive.google.com/drive/folders/${ID}`, "folder", `https://drive.google.com/embeddedfolderview?id=${ID}#list`],
    [`https://drive.google.com/drive/u/1/folders/${ID}?usp=sharing`, "folder", `https://drive.google.com/embeddedfolderview?id=${ID}#list`],
    [`https://drive.google.com/open?id=${ID}`, "file", `https://drive.google.com/file/d/${ID}/preview`],
    [`http://docs.google.com/document/d/${ID}`, "document", `https://docs.google.com/document/d/${ID}/preview`],
  ])("recognises %s", (url, kind, embedUrl) => {
    const link = parseGoogleDriveLink(url)
    expect(link).toMatchObject({ kind, fileId: ID, embedUrl })
  })

  it("recognises a Form but offers no in-place preview, because the viewer is a submittable form", () => {
    const link = parseGoogleDriveLink(`https://docs.google.com/forms/d/e/${ID}/viewform`)
    expect(link).toMatchObject({ kind: "form", fileId: ID, label: "Google Form", embedUrl: null })
  })

  it("builds the embed URL from the file ID alone, never from the pasted string", () => {
    const link = parseGoogleDriveLink(`https://docs.google.com/document/d/${ID}/edit?x=1&next=https://evil.example`)
    expect(link?.embedUrl).toBe(`https://docs.google.com/document/d/${ID}/preview`)
  })

  it.each([
    "https://docs.google.com.evil.example/document/d/" + ID + "/edit",
    "https://evil.example/docs.google.com/document/d/" + ID,
    "https://notdocs.google.com/document/d/" + ID,
    "https://sites.google.com/document/d/" + ID,
    `https://user:pass@docs.google.com/document/d/${ID}/edit`,
    `https://docs.google.com:8443/document/d/${ID}/edit`,
    `javascript:alert(1)//docs.google.com/document/d/${ID}`,
    `ftp://docs.google.com/document/d/${ID}`,
    "https://docs.google.com/document/d/short/edit",
    "https://docs.google.com/document/d/",
    "https://docs.google.com/",
    "https://drive.google.com/drive/my-drive",
    "https://drive.google.com/open?id=short",
    "https://drive.google.com/open",
    "https://example.com/report",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(parseGoogleDriveLink(url)).toBeNull()
  })

  it("handles missing input", () => {
    expect(parseGoogleDriveLink(null)).toBeNull()
    expect(parseGoogleDriveLink(undefined)).toBeNull()
    expect(isGoogleDriveUrl(`https://docs.google.com/document/d/${ID}/edit`)).toBe(true)
    expect(isGoogleDriveUrl("https://example.com")).toBe(false)
  })

  it("is case-insensitive about the host", () => {
    expect(parseGoogleDriveLink(`https://Docs.Google.com/document/d/${ID}/edit`)?.kind).toBe("document")
  })
})
