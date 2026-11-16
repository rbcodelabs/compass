/**
 * Reading the agent's final doc tree back (scripts/agent/docs-final-state.ts).
 *
 * The regression this guards: the SDK's native Write/Edit tools write straight to
 * disk, and a wiki session is a SCAN, so nothing the agent wrote natively is visible
 * to listFiles()/readNote() until refresh(). These tests drive a REAL wiki session
 * (@rbcodelabs/geode-headless/wiki) over a REAL temp folder and change it with plain
 * fs, exactly as the file tools do, never through the session API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openWikiSession, type WikiSession } from "@rbcodelabs/geode-headless/wiki"
import { MAX_DOC_PATH_LENGTH, collectFinalDocState, isValidDocName, postDocsReconcile } from "../../scripts/agent/docs-final-state"

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

  it("is incomplete AND refreshFailed when the refresh reports an error (the scan is stale: nothing in it is trustworthy)", async () => {
    const real = await open()
    const session = new Proxy(real, {
      get: (target, prop) => (prop === "refresh" ? async () => ({ status: "error", error: { code: "boom" } }) : (target as never)[prop]),
    })
    const state = await collectFinalDocState(session)
    expect(state.incomplete).toBe(true)
    expect(state.refreshFailed).toBe(true)
  })

  it("a healthy refresh leaves refreshFailed false, and so does a mere discovery limit", async () => {
    expect((await collectFinalDocState(await open())).refreshFailed).toBe(false)
    for (let i = 0; i < 30; i++) doc(`Many/Doc ${i}/_doc.md`, "x")
    const opened = await openWikiSession(root, { limits: { maxEntries: 10 } })
    if (opened.status !== "ok") throw new Error("open failed")
    const limited = await collectFinalDocState(opened.session)
    expect(limited.incomplete).toBe(true)
    expect(limited.refreshFailed).toBe(false)
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
    expect(state.refreshFailed).toBe(true)
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

describe("collectFinalDocState reports stray notes instead of dropping them silently", () => {
  it("lists a root-level _doc.md and a note that is not a doc's _doc.md", async () => {
    const session = await open()
    doc("_doc.md", "no doc to belong to")
    doc("Product/notes.md", "a stray note beside the doc")
    doc("loose.md", "a loose note")
    const state = await collectFinalDocState(session)
    expect(state.files.map((f) => f.path)).toEqual(["Product"])
    expect(state.skippedNames.sort()).toEqual(["Product/notes.md", "_doc.md", "loose.md"])
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

describe("postDocsReconcile", () => {
  const post = { url: "https://compass.test/api/internal/agent/runs/r/docs", init: { method: "POST" as const, headers: { authorization: "Bearer t" }, body: "{}" } }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  const run = (responses: Array<Response | Error>) => {
    const queue = [...responses]
    const fetcher = vi.fn(async () => {
      const next = queue.shift()
      if (!next) throw new Error("unexpected extra attempt")
      if (next instanceof Error) throw next
      return next
    })
    const sleep = vi.fn(async () => {})
    return { fetcher, sleep, result: postDocsReconcile(post, { fetcher: fetcher as unknown as typeof fetch, sleep }) }
  }

  it("returns the notice on success without retrying", async () => {
    const t = run([json(200, { applied: 1, notice: "ok notice" })])
    expect(await t.result).toEqual({ kind: "ok", notice: "ok notice" })
    expect(t.fetcher).toHaveBeenCalledTimes(1)
    expect(t.sleep).not.toHaveBeenCalled()
  })

  it("retries a 5xx and a network error, then succeeds (the reconcile is idempotent per operation id)", async () => {
    const t = run([json(503, {}), new Error("fetch failed"), json(200, { notice: null })])
    expect(await t.result).toEqual({ kind: "ok", notice: null })
    expect(t.fetcher).toHaveBeenCalledTimes(3)
    expect(t.sleep).toHaveBeenCalledTimes(2)
  })

  it("gives up after three attempts and reports the last cause", async () => {
    const t = run([json(500, {}), json(502, {}), json(504, {})])
    const outcome = await t.result
    expect(outcome).toMatchObject({ kind: "failed" })
    expect((outcome as { detail: string }).detail).toContain("504")
    expect((outcome as { detail: string }).detail).toContain("3 attempts")
    expect(t.fetcher).toHaveBeenCalledTimes(3)
  })

  it("does not retry a 4xx, and names the read-only refusal specifically", async () => {
    const readOnly = run([json(403, { error: "x", code: "AGENT_READ_ONLY" })])
    expect(await readOnly.result).toEqual({ kind: "read-only" })
    expect(readOnly.fetcher).toHaveBeenCalledTimes(1)
    const forbidden = run([json(403, { code: "WORKSPACE_ACCESS_REVOKED" })])
    expect(await forbidden.result).toEqual({ kind: "failed", detail: "docs reconciliation returned 403 (WORKSPACE_ACCESS_REVOKED)" })
    expect(forbidden.fetcher).toHaveBeenCalledTimes(1)
    const invalid = run([json(422, {})])
    expect(await invalid.result).toMatchObject({ kind: "failed" })
    expect(invalid.fetcher).toHaveBeenCalledTimes(1)
  })
})
