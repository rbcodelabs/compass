import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: () => ({}) }))

import { parseUploadRefs, safeUploadName } from "@/lib/agent-turn-attachments"

const UUID = "123e4567-e89b-12d3-a456-426614174000"

describe("upload refs", () => {
  it("accepts a normal ref and rejects traversal-shaped names", () => {
    expect(parseUploadRefs([`${UUID}/notes.txt`])).toEqual([`${UUID}/notes.txt`])
    expect(parseUploadRefs([`${UUID}/..`, `${UUID}/.`, `${UUID}/.env`, `${UUID}/../x`, `${UUID}/a/b`, `../${UUID}/x`])).toEqual([])
  })

  it("sanitizes client file names", () => {
    expect(safeUploadName("../../etc/passwd")).toBe("passwd")
    expect(safeUploadName("..")).toBe("file")
    expect(safeUploadName(".env")).toBe("env")
  })
})
