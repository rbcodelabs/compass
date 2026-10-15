/**
 * Reading the agent's final doc tree back (scripts/agent/docs-final-state.ts).
 *
 * The regression this guards: the SDK's native Write/Edit tools write straight to
 * disk, and a wiki session is a SCAN, so nothing the agent wrote natively is visible
 * to listFiles()/readNote() until refresh(). These tests drive a REAL wiki session
 * (@rbcodelabs/geode-headless/wiki) over a REAL temp folder and change it with plain
 * fs, exactly as the file tools do, never through the session API.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openWikiSession, type WikiSession } from "@rbcodelabs/geode-headless/wiki"
import { MAX_DOC_PATH_LENGTH, collectFinalDocState, isValidDocName } from "../../scripts/agent/docs-final-state"

let root: string

const doc = (relative: string, text: string) => {
  mkdirSync(path.join(root, path.dirname(relative)), { recursive: true })
  writeFileSync(path.join(root, relative), text)
}
const open = async (): Promise<WikiSession> => {
  const opened = await openWikiSession(root)
  if (opened.status !== "ok") throw new Error(`could not open the session: ${JSON.stringify(opened)}`)
  return opened.session
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "docs-final-"))
  doc("Product/_doc.md", "---\ncompass_doc_id: doc-1\n---\noriginal body")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("collectFinalDocState sees what the native file tools wrote", () => {
  it("collects a native EDIT and a native CREATE made after the session was opened", async () => {
    const session = await open()
    doc("Product/_doc.md", "---\ncompass_doc_id: doc-1\n---\nedited natively by the agent")
    doc("Product/New Idea/_doc.md", "brand new, written with plain fs")

    // The premise of the bug: the session does not see native writes on its own.
    expect(session.listFiles().map((f) => f.path)).not.toContain("Product/New Idea/_doc.md")

    const state = await collectFinalDocState(session)
    expect(state.incomplete).toBe(false)
    const byPath = new Map(state.files.map((f) => [f.path, f]))
    expect(byPath.get("Product")?.content).toContain("edited natively by the agent")
    expect(byPath.get("Product")?.frontmatterDocId).toBe("doc-1")
    expect(byPath.get("Product/New Idea")).toMatchObject({ content: "brand new, written with plain fs", frontmatterDocId: null })
  })

  it("an untouched tree comes back unchanged", async () => {
    const state = await collectFinalDocState(await open())
    expect(state.files).toEqual([{ path: "Product", content: expect.stringContaining("original body"), frontmatterDocId: "doc-1" }])
    expect(state.incomplete).toBe(false)
  })

  it("a file removed natively is simply absent (deletion is signalled separately, never inferred)", async () => {
    const session = await open()
    rmSync(path.join(root, "Product"), { recursive: true })
    const state = await collectFinalDocState(session)
    expect(state.files).toEqual([])
    expect(state.incomplete).toBe(false)
  })

  it("also reflects changes made through the session's own methods", async () => {
    const session = await open()
    doc("Scratch/_doc.md", "to be deleted")
    await session.refresh()
    expect((await session.deleteNote("Scratch/_doc.md")).status).toBe("ok")
    const state = await collectFinalDocState(session)
    expect(state.files.map((f) => f.path)).toEqual(["Product"])
  })
})

describe("collectFinalDocState reports when it cannot be trusted", () => {
  it("is incomplete when a note is too large for the wiki to read", async () => {
    const session = await open()
    doc("Big/_doc.md", "x".repeat(3 * 1024 * 1024))
    const state = await collectFinalDocState(session)
    expect(state.incomplete).toBe(true)
    expect(state.files.map((f) => f.path)).toEqual(["Product"])
  })

  it("is incomplete when the refresh reports an error", async () => {
    const real = await open()
    const session = new Proxy(real, {
      get: (target, prop) => (prop === "refresh" ? async () => ({ status: "error", error: { code: "boom" } }) : (target as never)[prop]),
    })
    expect((await collectFinalDocState(session)).incomplete).toBe(true)
  })

  it("is incomplete when the refresh throws", async () => {
    const real = await open()
    const session = new Proxy(real, {
      get: (target, prop) =>
        prop === "refresh"
          ? async () => {
              throw new Error("disk went away")
            }
          : (target as never)[prop],
    })
    const logs: string[] = []
    const state = await collectFinalDocState(session, (m) => logs.push(m))
    expect(state.incomplete).toBe(true)
    expect(logs.join(" ")).toContain("disk went away")
  })

  it("is incomplete when discovery hit a limit", async () => {
    for (let i = 0; i < 30; i++) doc(`Many/Doc ${i}/_doc.md`, "x")
    const opened = await openWikiSession(root, { limits: { maxEntries: 10 } })
    if (opened.status !== "ok") throw new Error("open failed")
    expect((await collectFinalDocState(opened.session)).incomplete).toBe(true)
  })
})

describe("collectFinalDocState skips names the server would refuse", () => {
  it("leaves out a colon, a leading tilde and a $, and says so", async () => {
    const session = await open()
    doc("Q3: Plan/_doc.md", "x")
    doc("~draft/_doc.md", "x")
    doc("cost $5/_doc.md", "x")
    const state = await collectFinalDocState(session)
    expect(state.files.map((f) => f.path)).toEqual(["Product"])
    expect(state.skippedNames.sort()).toEqual(["Q3: Plan", "cost $5", "~draft"])
    expect(state.incomplete).toBe(false)
  })
})

describe("isValidDocName", () => {
  it("accepts normal names and rejects what the server rejects", () => {
    expect(isValidDocName("Product/Roadmap/Q3 Plan")).toBe(true)
    expect(isValidDocName("Rick's plan")).toBe(true)
    for (const bad of ["", ".hidden", "a/../b", "a//b", "~x", "a:b", "50%", "$x", "node_modules", "a/_doc.md", " pad", "pad ", "dot.", "'q'"]) {
      expect(isValidDocName(bad), bad).toBe(false)
    }
  })

  it("enforces the server's total path length cap, so one long path cannot 400 the whole turn", () => {
    const segment = "a".repeat(150)
    const ok = Array.from({ length: 27 }, () => segment).join("/") // 27*150 + 26 = 4076
    expect(ok.length).toBeLessThanOrEqual(MAX_DOC_PATH_LENGTH)
    expect(isValidDocName(ok)).toBe(true)
    expect(isValidDocName(`${ok}/${"b".repeat(30)}`)).toBe(false)
  })
})
