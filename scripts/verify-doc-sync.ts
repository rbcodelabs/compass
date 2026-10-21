/**
 * End-to-end proof of the Geode doc sync REST surface against a DEPLOYED Compass (a Vercel preview).
 * Exercises scan -> create -> replay -> read -> update -> conflict -> move -> delete -> delta, and exits
 * nonzero on the first mismatch. It creates a uniquely named folder of throwaway docs and removes it.
 *
 *   BASE_URL=https://<preview>.vercel.app TOKEN=cmp_... WORKSPACE_ID=<uuid> \
 *   [VERCEL_BYPASS_SECRET=...] npx tsx scripts/verify-doc-sync.ts
 *
 * Refuses to run against production (compass.rbcodelabs.com). Never prints the token.
 * The checks live in `verifyDocSync` so the unit tests can run the very same script against the
 * in-process handler.
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Result = { status: number; json: Json | null }

export type VerifyConfig = {
  baseUrl: string
  token: string
  workspaceId: string
  bypassSecret?: string
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")

/** Returns the number of checks that passed; throws on the first mismatch. */
export async function verifyDocSync(cfg: VerifyConfig): Promise<number> {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, "")
  if (!baseUrl || !cfg.token || !cfg.workspaceId) throw new Error("baseUrl, token and workspaceId are required")
  if (new URL(baseUrl).hostname === "compass.rbcodelabs.com") throw new Error("Refusing to run against production")
  const doFetch = cfg.fetchImpl ?? fetch
  const log = cfg.log ?? ((line: string) => console.log(line))
  const root = `${baseUrl}/api/v1/workspaces/${cfg.workspaceId}/sync/docs`
  const run = randomUUID().slice(0, 8)
  const folder = `sync-verify-${run}`
  let step = 0
  const ok = (message: string) => log(`ok ${++step} - ${message}`)

  async function call(method: string, path: string, body?: unknown): Promise<Result> {
    const response = await doFetch(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(cfg.bypassSecret ? { "x-vercel-protection-bypass": cfg.bypassSecret } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    })
    if (response.status >= 300 && response.status < 400) throw new Error(`${method} ${path} redirected to ${response.headers.get("location")}: Vercel protection needs the bypass secret`)
    const text = await response.text()
    let json: Json | null = null
    if (text) { try { json = JSON.parse(text) } catch { throw new Error(`${method} ${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`) } }
    return { status: response.status, json }
  }

  /** Reads every page of a snapshot; returns the entries and the checkpoint cursor. */
  async function fullSnapshot(): Promise<{ entries: Json[]; cursor: string }> {
    const entries: Json[] = []
    let continuation: string | null = null
    for (let page = 0; page < 1000; page++) {
      const r: Result = await call("GET", `/scan?limit=200${continuation ? `&continuation=${encodeURIComponent(continuation)}` : ""}`)
      assert.equal(r.status, 200, `scan failed: ${JSON.stringify(r.json)}`)
      assert.equal(r.json!.mode, "snapshot")
      entries.push(...r.json!.entries)
      if (!r.json!.hasMore) {
        assert.equal(r.json!.status, "complete", `snapshot was partial: ${JSON.stringify(r.json!.skipped)}`)
        assert.ok(r.json!.cursor, "complete snapshot must carry a cursor")
        return { entries, cursor: r.json!.cursor }
      }
      continuation = r.json!.continuation
      assert.ok(continuation, "hasMore without a continuation")
    }
    throw new Error("snapshot did not terminate")
  }

  async function delta(cursor: string): Promise<Json> {
    const r = await call("GET", `/scan?cursor=${encodeURIComponent(cursor)}`)
    assert.equal(r.status, 200, `delta failed: ${JSON.stringify(r.json)}`)
    assert.equal(r.json!.mode, "delta", "expected a delta, got a snapshot (epoch changed?)")
    assert.equal(r.json!.status, "complete")
    return r.json!
  }

  /** Best effort: delete everything under the run's folder, deepest first. */
  async function cleanup() {
    for (let pass = 0; pass < 6; pass++) {
      const mine = (await fullSnapshot()).entries.filter((e) => e.path === folder || e.path.startsWith(`${folder}/`))
      if (mine.length === 0) return
      mine.sort((a, b) => b.path.split("/").length - a.path.split("/").length)
      for (const e of mine) await call("DELETE", `/${e.id}?expectedRevision=${encodeURIComponent(e.revision)}`)
    }
  }

  try {
    // 1. scan
    const base = await fullSnapshot()
    ok(`snapshot of ${base.entries.length} entries with a checkpoint cursor`)

    // 2. create (+ idempotent replay)
    const key = `verify-${run}-create`
    const created = await call("POST", "", { path: `${folder}/Note.md`, content: "# Note\nfirst\n", operationKey: key })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const note = created.json!
    assert.equal(note.path, `${folder}/Note`)
    assert.equal(note.kind, "file")
    assert.equal(note.operationKey, key)
    const replay = await call("POST", "", { path: `${folder}/Note.md`, content: "# Note\nfirst\n", operationKey: key })
    assert.equal(replay.status, 201)
    assert.deepEqual(replay.json, note, "replaying the same operationKey must return the same entry")
    ok("create returns 201 and replays idempotently")

    // 3. read
    const read = await call("GET", `/${note.id}`)
    assert.equal(read.status, 200)
    assert.equal(read.json!.revision, note.revision)
    assert.equal(read.json!.hash, sha(read.json!.content), "hash must be sha256 of the returned content")
    assert.equal(read.json!.size, Buffer.byteLength(read.json!.content, "utf8"))
    assert.equal(read.json!.hash, note.hash)
    assert.ok(read.json!.content.includes("first"))
    ok("read content matches the entry's size and hash")

    // 4. delta after create
    let d = await delta(base.cursor)
    const seen = d.entries.find((e: Json) => e.id === note.id)
    assert.ok(seen, "created doc missing from delta")
    assert.equal(seen.revision, note.revision)
    assert.equal(seen.hash, note.hash)
    assert.ok(d.entries.some((e: Json) => e.path === folder && e.kind === "folder"), "implicit parent folder missing from delta")
    ok("delta shows the new file and its implicit folder with matching revision/hash")

    // 5. update, then a stale update conflicts
    const updated = await call("PUT", `/${note.id}`, { content: "# Note\nsecond\n", expectedRevision: note.revision, operationKey: `verify-${run}-update` })
    assert.equal(updated.status, 200, JSON.stringify(updated.json))
    assert.notEqual(updated.json!.revision, note.revision)
    const stale = await call("PUT", `/${note.id}`, { content: "# lost\n", expectedRevision: note.revision, operationKey: `verify-${run}-stale` })
    assert.equal(stale.status, 409)
    assert.equal(stale.json!.code, "revision_conflict")
    assert.ok((await call("GET", `/${note.id}`)).json!.content.includes("second"), "stale write must not change the doc")
    ok("update succeeds; stale expectedRevision is 409 revision_conflict")

    // 6. strict validation
    const bad = await call("POST", "", { path: `${folder}/image.png`, content: "x", operationKey: `verify-${run}-ext` })
    assert.equal(bad.status, 422)
    assert.equal(bad.json!.code, "unsupported_extension")
    ok("non-.md path is 422 unsupported_extension")

    // 7. move (+ stale + occupied)
    const other = await call("POST", "", { path: `${folder}/Other.md`, content: "# Other\n", operationKey: `verify-${run}-other` })
    assert.equal(other.status, 201)
    const staleMove = await call("POST", `/${note.id}/move`, { path: `${folder}/Sub/Moved.md`, expectedRevision: note.revision })
    assert.equal(staleMove.status, 409)
    assert.equal(staleMove.json!.code, "revision_conflict")
    const occupied = await call("POST", `/${note.id}/move`, { path: `${folder}/Other.md`, expectedRevision: updated.json!.revision })
    assert.equal(occupied.status, 409)
    assert.equal(occupied.json!.code, "path_conflict")
    const moved = await call("POST", `/${note.id}/move`, { path: `${folder}/Sub/Moved.md`, expectedRevision: updated.json!.revision })
    assert.equal(moved.status, 200, JSON.stringify(moved.json))
    assert.equal(moved.json!.path, `${folder}/Sub/Moved`)
    ok("move succeeds; stale is revision_conflict; occupied is path_conflict")

    // 8. delta after update + move
    d = await delta(d.cursor)
    const movedSeen = d.entries.find((e: Json) => e.id === note.id)
    assert.ok(movedSeen, "moved doc missing from delta")
    assert.equal(movedSeen.path, `${folder}/Sub/Moved`)
    assert.equal(movedSeen.revision, moved.json!.revision)
    assert.equal(movedSeen.hash, moved.json!.hash)
    ok("delta shows the update and move at the new path with the returned revision")

    // 9. delete: stale, has_children, then a leaf delete leaves a tombstone
    const noStale = await call("DELETE", `/${note.id}?expectedRevision=stale`)
    assert.equal(noStale.status, 409)
    assert.equal(noStale.json!.code, "revision_conflict")
    const folderEntry = (await fullSnapshot()).entries.find((e) => e.path === folder)
    assert.ok(folderEntry, "folder entry missing")
    const hasChildren = await call("DELETE", `/${folderEntry.id}?expectedRevision=${encodeURIComponent(folderEntry.revision)}`)
    assert.equal(hasChildren.status, 409)
    assert.equal(hasChildren.json!.code, "has_children")
    const checkpoint = d.cursor
    const gone = await call("DELETE", `/${note.id}?expectedRevision=${encodeURIComponent(moved.json!.revision)}`)
    assert.equal(gone.status, 204)
    d = await delta(checkpoint)
    const tomb = d.entries.find((e: Json) => e.id === note.id)
    assert.ok(tomb && tomb.kind === "tombstone" && tomb.path === `${folder}/Sub/Moved`, `expected a tombstone, got ${JSON.stringify(tomb)}`)
    ok("delete: stale is revision_conflict, folder is has_children, leaf delete leaves a tombstone")
  } finally {
    await cleanup().catch(() => undefined)
  }
  ok("cleanup done")
  log(`verify-doc-sync: all ${step} checks passed against ${new URL(baseUrl).host}`)
  return step
}

if (process.argv[1]?.endsWith("verify-doc-sync.ts")) {
  verifyDocSync({
    baseUrl: process.env.BASE_URL ?? "",
    token: process.env.TOKEN ?? "",
    workspaceId: process.env.WORKSPACE_ID ?? "",
    bypassSecret: process.env.VERCEL_BYPASS_SECRET ?? process.env.COMPASS_VERCEL_BYPASS_SECRET,
  }).catch((error) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
