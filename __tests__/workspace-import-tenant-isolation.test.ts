/**
 * Security finding H1: a crafted workspace bundle must not write into, read from, or delete anything outside the
 * workspace it creates. These tests run the real importer against an in-memory client (no database) and a
 * recording object store, then assert nothing landed outside the new workspace.
 */
import { randomUUID } from "node:crypto"
import { zipSync } from "fflate"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ArtifactStorage } from "@/lib/artifact-storage"
import type { BlobAdapters } from "@/lib/workspace-export/blobs"
import { WorkspaceImportError, importWorkspaceBundle } from "@/lib/workspace-export/import"
import {
  capabilityPackArtifactPath,
  confineStoragePath,
  isOwnFeedbackAttachmentUrl,
} from "@/lib/workspace-export/path-confinement"

type Row = Record<string, unknown>
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v))
const ndjson = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n"

// ---- in-memory Prisma stand-in -------------------------------------------------------------------------------------
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as Row)) return ((v as { in: unknown[] }).in).includes(row[k])
    return row[k] === v
  })
}
function fakeClient(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed))
  const table = (name: string) => tables.get(name) ?? tables.set(name, []).get(name)!
  const delegate = (name: string) => ({
    findMany: async ({ where, take }: { where?: Row; take?: number }) => table(name).filter((r) => matches(r, where)).slice(0, take),
    count: async ({ where }: { where?: Row }) => table(name).filter((r) => matches(r, where)).length,
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let n = 0
      for (const d of data) {
        if (skipDuplicates && d.id !== undefined && table(name).some((r) => r.id === d.id)) continue
        table(name).push({ ...d })
        n++
      }
      return { count: n }
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const keep = table(name).filter((r) => !matches(r, where))
      const count = table(name).length - keep.length
      tables.set(name, keep)
      return { count }
    },
    updateMany: async () => ({ count: 0 }),
    aggregate: async () => ({ _max: { seqNumber: null } }),
  })
  const client: Record<string, unknown> = new Proxy({}, {
    get: (_t, prop: string) => (prop === "$transaction" ? (fn: (tx: unknown) => unknown) => fn(client) : delegate(prop.charAt(0).toUpperCase() + prop.slice(1))),
  })
  return { client, table }
}

// ---- recording object store ----------------------------------------------------------------------------------------
function recordingStorage(initial: Record<string, string> = {}, alwaysExisting: (p: string) => boolean = () => false) {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([k, v]) => [k, enc(v)]))
  const puts: { path: string; overwrite: boolean | undefined }[] = []
  const dels: string[] = []
  const storage: ArtifactStorage = {
    async put(path, bytes, _type, options) {
      puts.push({ path, overwrite: options?.overwrite })
      if (options?.overwrite === false && (files.has(path) || alwaysExisting(path))) return { pathname: path, created: false }
      files.set(path, bytes)
      return { pathname: path, created: true }
    },
    async get(path) {
      return files.get(path) ?? null
    },
    async del(path) {
      dels.push(path)
      files.delete(path)
    },
  }
  return { storage, files, puts, dels }
}

// ---- fixture -------------------------------------------------------------------------------------------------------
const orgId = randomUUID()
const importerId = randomUUID()
const victimWs = randomUUID()
const victimObj = randomUUID()
const srcWs = randomUUID()
const STORE_HOST = "store123.public.blob.vercel-storage.com"
const OWN_FEEDBACK_URL = `https://${STORE_HOST}/feedback/${srcWs}/${randomUUID()}-shot.png`

type BundleSpec = {
  rows?: Record<string, Row[]>
  blobs?: { store: "artifact" | "research" | "feedback"; key: string; contentType?: string; data?: string }[]
  manifest?: Partial<{
    counts: Record<string, number>
    scoringModels: { id: string; organizationId: string }[]
    users: { id: string; email: string }[]
  }>
}
function bundle(spec: BundleSpec): Uint8Array {
  const rows: Record<string, Row[]> = {
    Workspace: [{ id: srcWs, organizationId: randomUUID(), name: "Src", slug: "src" }],
    ...spec.rows,
  }
  const files: Record<string, Uint8Array> = {}
  const counts: Record<string, number> = {}
  for (const [model, list] of Object.entries(rows)) {
    files[`data/${model}.0000.ndjson`] = enc(ndjson(list))
    counts[model] = list.length
  }
  for (const b of spec.blobs ?? []) if (b.data !== undefined) files[`blobs/${b.store}/${b.key}`] = enc(b.data)
  files["manifest.json"] = enc({
    formatVersion: 1,
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    tier: "core",
    source: { workspaceId: srcWs, organizationId: randomUUID(), slug: "src", name: "Src" },
    counts: { ...counts, ...spec.manifest?.counts },
    users: spec.manifest?.users ?? [],
    scoringModels: spec.manifest?.scoringModels ?? [],
    blobs: (spec.blobs ?? []).map((b) => ({ store: b.store, key: b.key, contentType: b.contentType ?? "text/html" })),
    warnings: [],
  })
  return zipSync(files)
}

let db: ReturnType<typeof fakeClient>
let artifact: ReturnType<typeof recordingStorage>
let research: ReturnType<typeof recordingStorage>
let publicPuts: string[]
let blobs: BlobAdapters

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store123_secret")
  db = fakeClient({
    Organization: [{ id: orgId }],
    OrganizationMember: [{ organizationId: orgId, userId: importerId, role: "ADMIN" }],
    User: [{ id: importerId, email: "importer@example.com" }],
  })
  artifact = recordingStorage({ [`artifacts/${victimWs}/${victimObj}/secret.html`]: "VICTIM-ARTIFACT" })
  research = recordingStorage({ [`research/${victimWs}/s/t/secret.png`]: "VICTIM-RESEARCH" })
  publicPuts = []
  blobs = {
    artifact: artifact.storage,
    research: research.storage,
    fetchPublic: async () => null,
    async putPublic(path) {
      publicPuts.push(path)
      return `https://${STORE_HOST}/${path}`
    },
    async delPublic() {},
  }
})

const run = (spec: BundleSpec, nonce = "n1") =>
  importWorkspaceBundle(db.client, bundle(spec), { organizationId: orgId, importerUserId: importerId, blobs, nonce, slug: `imp-${nonce}` })

/** Every row in the fake database that belongs to a workspace-scoped model. */
function allWorkspaceIds(): Set<string> {
  const ids = new Set<string>()
  for (const name of ["Opportunity", "Doc", "Artifact", "Objective"]) for (const r of db.table(name)) ids.add(String(r.workspaceId))
  return ids
}

describe("H1: workspace import tenant isolation", () => {
  it("forces workspaceId to the new workspace on every row, whatever the bundle says", async () => {
    const report = await run({
      rows: {
        Opportunity: [
          { id: randomUUID(), workspaceId: victimWs, title: "stolen into victim" },
          { id: randomUUID(), workspaceId: srcWs, title: "honest" },
          { id: randomUUID(), workspaceId: randomUUID(), title: "random" },
        ],
        Doc: [{ id: randomUUID(), workspaceId: victimWs, title: "d", content: "x" }],
      },
    })
    expect([...allWorkspaceIds()]).toEqual([report.workspaceId])
    expect(db.table("Opportunity")).toHaveLength(3)
    expect(db.table("Opportunity").some((r) => r.workspaceId === victimWs)).toBe(false)
  })

  it("drops child rows whose required parent id is not in the bundle (fail closed)", async () => {
    const goodObjective = randomUUID()
    const goodSolution = randomUUID()
    const report = await run({
      rows: {
        Objective: [{ id: goodObjective, workspaceId: srcWs, title: "o" }],
        KeyResult: [
          { id: randomUUID(), objectiveId: goodObjective, title: "ok" },
          { id: randomUUID(), objectiveId: randomUUID(), title: "foreign objective" },
        ],
        Solution: [{ id: goodSolution, opportunityId: randomUUID(), title: "s", workspaceId: srcWs }],
        SolutionComment: [{ id: randomUUID(), solutionId: randomUUID(), body: "foreign solution" }],
        Assumption: [{ id: randomUUID(), solutionId: randomUUID(), workspaceId: victimWs, title: "a" }],
        Doc: [{ id: randomUUID(), workspaceId: srcWs, title: "d" }],
        DocVersion: [{ id: randomUUID(), docId: randomUUID(), title: "foreign doc" }],
      },
    })
    expect(db.table("KeyResult")).toHaveLength(1)
    expect(db.table("KeyResult")[0]!.title).toBe("ok")
    expect(db.table("SolutionComment")).toHaveLength(0)
    expect(db.table("Assumption")).toHaveLength(0)
    expect(db.table("DocVersion")).toHaveLength(0)
    expect(db.table("Solution")).toHaveLength(0) // its opportunity is not in the bundle either
    expect(report.warnings.join(" ")).toMatch(/Skipped 1 KeyResult/)
  })

  it("never lets the manifest's own counts vouch for the import", async () => {
    // The attacker claims 3 rows were exported; only one survives. The authoritative check is what was inserted.
    const report = await run({
      rows: { KeyResult: [{ id: randomUUID(), objectiveId: randomUUID(), title: "x" }] },
      manifest: { counts: { KeyResult: 1 } },
    })
    expect(report.counts.KeyResult).toBe(0)
  })

  it("rejects foreign / traversing storage paths and blob keys, and never touches the victim's objects", async () => {
    const artifactId = randomUUID()
    const goodRev = randomUUID()
    const goodPath = `artifacts/${srcWs}/${artifactId}/${goodRev}-page.html`
    const report = await run({
      rows: {
        Artifact: [{ id: artifactId, workspaceId: srcWs, title: "a" }],
        ArtifactRevision: [
          { id: goodRev, artifactId, revisionNumber: 1, blobPathname: goodPath, thumbnailPathname: `artifacts/${srcWs}/${artifactId}/thumbnails/t.png` },
          // foreign blob: the row is dropped
          { id: randomUUID(), artifactId, revisionNumber: 2, blobPathname: `artifacts/${victimWs}/${victimObj}/secret.html` },
          // traversal out of the source prefix: dropped
          { id: randomUUID(), artifactId, revisionNumber: 3, blobPathname: `artifacts/${srcWs}/../${victimWs}/${victimObj}/secret.html` },
          // good blob, foreign thumbnail: row kept, thumbnail cleared
          { id: randomUUID(), artifactId, revisionNumber: 4, blobPathname: goodPath, thumbnailPathname: `artifacts/${victimWs}/${victimObj}/secret.html` },
        ],
        ResearchAttachment: [
          { id: randomUUID(), workspaceId: srcWs, studyId: randomUUID(), sessionId: randomUUID(), blobPathname: `research/${victimWs}/s/t/secret.png` },
        ],
      },
      blobs: [
        { store: "artifact", key: goodPath, data: "MINE" },
        { store: "artifact", key: `artifacts/${victimWs}/${victimObj}/secret.html`, data: "OVERWRITE-ATTEMPT" },
        { store: "artifact", key: `docs/${victimWs}/images/x.png`, data: "OVERWRITE-ATTEMPT" },
        { store: "artifact", key: `artifacts/${srcWs}/../${victimWs}/${victimObj}/secret.html`, data: "OVERWRITE-ATTEMPT" },
        { store: "artifact", key: "/etc/passwd", data: "OVERWRITE-ATTEMPT" },
        { store: "research", key: `research/${victimWs}/s/t/secret.png`, data: "OVERWRITE-ATTEMPT" },
      ],
    })
    const revisions = db.table("ArtifactRevision")
    expect(revisions).toHaveLength(2)
    const prefix = `artifacts/${report.workspaceId}/`
    for (const r of revisions) {
      expect(String(r.blobPathname).startsWith(prefix)).toBe(true)
      if (r.thumbnailPathname) expect(String(r.thumbnailPathname).startsWith(prefix)).toBe(true)
    }
    expect(revisions.filter((r) => r.thumbnailPathname === null)).toHaveLength(1)
    expect(db.table("ResearchAttachment")).toHaveLength(0)
    // The only object written is the legitimate one, inside the new workspace, and always without overwrite.
    expect(artifact.puts).toHaveLength(1)
    expect(artifact.puts[0]!.path.startsWith(prefix)).toBe(true)
    expect(artifact.puts[0]!.overwrite).toBe(false)
    expect(research.puts).toHaveLength(0)
    // The victim's bytes are untouched and nothing was deleted.
    expect(new TextDecoder().decode(artifact.files.get(`artifacts/${victimWs}/${victimObj}/secret.html`)!)).toBe("VICTIM-ARTIFACT")
    expect(new TextDecoder().decode(research.files.get(`research/${victimWs}/s/t/secret.png`)!)).toBe("VICTIM-RESEARCH")
    expect(artifact.dels).toEqual([])
    expect(report.warnings.join(" ")).toMatch(/not under the source workspace/)
  })

  it("a forced failure rolls back only what this import created, never a pre-existing object", async () => {
    const artifactId = randomUUID()
    const pathA = `artifacts/${srcWs}/${artifactId}/a-created.html`
    const pathB = `artifacts/${srcWs}/${artifactId}/b-keepme.html`
    artifact = recordingStorage({}, (p) => p.endsWith("b-keepme.html"))
    blobs.artifact = artifact.storage
    await expect(
      run({
        rows: { Opportunity: [{ id: randomUUID(), workspaceId: srcWs, title: "o" }] },
        blobs: [
          { store: "artifact", key: pathA, data: "A" },
          { store: "artifact", key: pathB, data: "B" },
        ],
        manifest: { counts: { Opportunity: 99 } }, // forces "Validation failed" after the blobs were written
      }),
    ).rejects.toThrow(/Validation failed for Opportunity/)
    expect(artifact.dels.some((p) => p.endsWith("a-created.html"))).toBe(true)
    expect(artifact.dels.some((p) => p.endsWith("b-keepme.html"))).toBe(false)
    expect(db.table("Opportunity")).toHaveLength(0)
  })

  it("never keeps a source URL: a readable own-store file is copied into the NEW workspace's namespace with the FETCHED content type", async () => {
    const item = randomUUID()
    const own = randomUUID()
    const foreign = randomUUID()
    const fetched: string[] = []
    const puts: { path: string; contentType: string }[] = []
    const foreignUrl = `https://${STORE_HOST}/feedback/${victimWs}/${randomUUID()}-theirs.png`
    blobs.fetchPublic = async (url) => {
      fetched.push(url)
      return { bytes: new TextEncoder().encode("PNGBYTES"), contentType: "image/webp" }
    }
    blobs.putPublic = async (path, _bytes, contentType) => {
      puts.push({ path, contentType })
      return `https://${STORE_HOST}/${path}`
    }
    const report = await run({
      rows: {
        FeedbackItem: [{ id: item, workspaceId: srcWs, title: "f" }],
        FeedbackAttachment: [
          // fileType is bundle-controlled and must not decide the stored content type.
          { id: own, feedbackItemId: item, url: OWN_FEEDBACK_URL, filename: "a.png", fileType: "text/html", fileSize: 8 },
          // A hostile bundle's row pointing at a namespace that is not the bundle's own source workspace.
          { id: foreign, feedbackItemId: item, url: foreignUrl, filename: "b.png", fileType: "image/png", fileSize: 1 },
        ],
      },
    })
    const rows = db.table("FeedbackAttachment")
    expect(rows).toHaveLength(1)
    expect(String(rows[0].url).startsWith(`https://${STORE_HOST}/feedback/${report.workspaceId}/`)).toBe(true)
    expect(rows[0].url).not.toBe(OWN_FEEDBACK_URL)
    expect(puts).toHaveLength(1)
    expect(puts[0].contentType).toBe("image/webp")
    expect(fetched).toEqual([OWN_FEEDBACK_URL]) // the foreign-namespace URL is never read
    expect(report.warnings.filter((w) => /was skipped/.test(w))).toHaveLength(1) // the foreign-namespace row
  })

  it("drops a feedback attachment with no bytes whose source file is unreadable, malformed or not this deployment's own", async () => {
    const item = randomUUID()
    const unreadable = randomUUID()
    const external = randomUUID()
    const internal = randomUUID()
    const throws = randomUUID()
    const fetched: string[] = []
    blobs.fetchPublic = async (url) => {
      fetched.push(url)
      if (url.includes("boom")) throw new Error("provider down")
      return null
    }
    const report = await run({
      rows: {
        FeedbackItem: [{ id: item, workspaceId: srcWs, title: "f" }],
        FeedbackAttachment: [
          { id: unreadable, feedbackItemId: item, url: OWN_FEEDBACK_URL, filename: "a.png", fileType: "image/png", fileSize: 1 },
          { id: throws, feedbackItemId: item, url: `https://${STORE_HOST}/feedback/${srcWs}/boom-b.png`, filename: "b.png", fileType: "image/png", fileSize: 1 },
          { id: external, feedbackItemId: item, url: "http://169.254.169.254/latest/meta-data/", filename: "c.png", fileType: "image/png", fileSize: 1 },
          { id: internal, feedbackItemId: item, url: "https://evil.example/feedback/x.png", filename: "d.png", fileType: "image/png", fileSize: 1 },
        ],
      },
    })
    expect(db.table("FeedbackAttachment")).toHaveLength(0)
    expect(report.warnings.filter((w) => /Feedback attachment .* was skipped/.test(w))).toHaveLength(4)
    expect(fetched.sort()).toEqual([OWN_FEEDBACK_URL, `https://${STORE_HOST}/feedback/${srcWs}/boom-b.png`].sort()) // only parser-approved URLs are fetched
  })

  it("treats non-canonical UUID spellings as the ids they are (no allow-list bypass)", async () => {
    const goodObjective = randomUUID()
    const hex = (u: string) => u.replaceAll("-", "")
    const victim = randomUUID()
    await run({
      rows: {
        Objective: [{ id: goodObjective, workspaceId: srcWs, title: "o" }],
        KeyResult: [
          { id: randomUUID(), objectiveId: `{${victim}}`, title: "braced" },
          { id: randomUUID(), objectiveId: `urn:uuid:${victim}`, title: "urn" },
          { id: randomUUID(), objectiveId: hex(victim), title: "no hyphens" },
          { id: randomUUID(), objectiveId: victim.toUpperCase(), title: "upper" },
          // the same spellings of an id that IS in the bundle resolve to the new id
          { id: randomUUID(), objectiveId: hex(goodObjective), title: "ok-hex" },
          { id: randomUUID(), objectiveId: goodObjective.toUpperCase(), title: "ok-upper" },
        ],
      },
    })
    const krs = db.table("KeyResult")
    expect(krs.map((r) => r.title).sort()).toEqual(["ok-hex", "ok-upper"])
    const newObjective = db.table("Objective")[0]!.id
    expect(krs.every((r) => r.objectiveId === newObjective)).toBe(true)
  })

  it("clears Geode document references and ignores scoring models the manifest only claims", async () => {
    const foreignModel = randomUUID()
    await run({
      rows: {
        Doc: [{ id: randomUUID(), workspaceId: srcWs, title: "d", storageProvider: "GEODE", contentRef: '{"object":"someone-elses"}' }],
        Opportunity: [{ id: randomUUID(), workspaceId: srcWs, title: "o" }],
        OpportunityScore: [{ id: randomUUID(), opportunityId: "00000000-0000-0000-0000-000000000000", scoringModelId: foreignModel }],
      },
      manifest: { scoringModels: [{ id: foreignModel, organizationId: orgId }] }, // claims to be in the target org; it is not
    })
    const doc = db.table("Doc")[0]!
    expect(doc.contentRef).toBeNull()
    expect(doc.storageProvider).toBeNull()
    expect(db.table("OpportunityScore")).toHaveLength(0)
  })

  it("still imports an honest bundle, copying its blob into the new workspace without overwrite", async () => {
    const artifactId = randomUUID()
    const rev = randomUUID()
    const path = `artifacts/${srcWs}/${artifactId}/${rev}-page.html`
    const report = await run({
      rows: {
        Artifact: [{ id: artifactId, workspaceId: srcWs, title: "a" }],
        ArtifactRevision: [{ id: rev, artifactId, revisionNumber: 1, blobPathname: path }],
      },
      blobs: [{ store: "artifact", key: path, data: "HELLO" }],
    })
    expect(report.blobsCopied).toBe(1)
    const stored = String(db.table("ArtifactRevision")[0]!.blobPathname)
    expect(stored.startsWith(`artifacts/${report.workspaceId}/`)).toBe(true)
    expect(new TextDecoder().decode(artifact.files.get(stored)!)).toBe("HELLO")
    expect(artifact.puts[0]!.overwrite).toBe(false)
  })

  it("keeps a tracked-decision review request: its subjectId is an idempotency key, re-derived per import", async () => {
    const key = randomUUID()
    const row = { id: randomUUID(), workspaceId: srcWs, gateType: "RELEASE", subjectType: "TRACKED_DECISION", subjectId: key, state: "DRAFT" }
    const first = await run({ rows: { ReviewRequest: [row] } }, "td1")
    const second = await run({ rows: { ReviewRequest: [row] } }, "td2")
    const subjects = db.table("ReviewRequest").map((r) => r.subjectId)
    expect(subjects).toHaveLength(2)
    expect(subjects).not.toContain(key)
    expect(new Set(subjects).size).toBe(2) // stays unique per import
    expect(first.warnings.join(" ")).not.toMatch(/Skipped 1 ReviewRequest/)
    expect(second.workspaceId).not.toBe(first.workspaceId)
    // Any other subject type still has to resolve inside the bundle.
    await run({ rows: { ReviewRequest: [{ ...row, id: randomUUID(), subjectType: "OPPORTUNITY" }] } }, "td3")
    expect(db.table("ReviewRequest")).toHaveLength(2)
  })

  it("skips a row whose unique key would repeat when unmatched users collapse onto the importer", async () => {
    const opp = randomUUID()
    const [u1, u2] = [randomUUID(), randomUUID()]
    const follow = (userId: string) => ({ id: randomUUID(), workspaceId: srcWs, userId, subjectType: "OPPORTUNITY", subjectId: opp, state: "ON", source: "MANUAL" })
    const report = await run({
      rows: { Opportunity: [{ id: opp, workspaceId: srcWs, title: "o" }], Follow: [follow(u1), follow(u2)] },
      manifest: {
        users: [
          { id: u1, email: "nobody1@example.com" },
          { id: u2, email: "nobody2@example.com" },
        ],
      },
    })
    expect(db.table("Follow")).toHaveLength(1)
    expect(db.table("Follow")[0]!.userId).toBe(importerId)
    expect(report.warnings.join(" ")).toMatch(/Skipped 1 Follow row\(s\) that would duplicate/)
  })

  it("rejects a non-bundle outright", async () => {
    await expect(importWorkspaceBundle(db.client, new Uint8Array([1, 2, 3]), { organizationId: orgId, importerUserId: importerId, blobs })).rejects.toBeInstanceOf(WorkspaceImportError)
  })
})

describe("path confinement helpers", () => {
  const ws = randomUUID()
  const nw = randomUUID()
  const rewrite = (t: string) => t.replaceAll(ws, nw)
  it("accepts only the source workspace's own prefix and rewrites into the new one", () => {
    expect(confineStoragePath("artifact", `artifacts/${ws}/a/b.html`, ws, nw, rewrite)).toBe(`artifacts/${nw}/a/b.html`)
    expect(confineStoragePath("artifact", `docs/${ws}/images/i.png`, ws, nw, rewrite)).toBe(`docs/${nw}/images/i.png`)
    expect(confineStoragePath("research", `research/${ws}/s/t/x.png`, ws, nw, rewrite)).toBe(`research/${nw}/s/t/x.png`)
  })
  it("rejects foreign prefixes, wrong stores, traversal, absolute and malformed paths", () => {
    for (const bad of [`artifacts/${randomUUID()}/a`, `research/${ws}/a/b`, `artifacts/${ws}/../x/y`, `/artifacts/${ws}/a/b`, `artifacts/${ws}//a`, `artifacts/${ws}\\a`, `artifacts/${ws}`, "", 7]) {
      expect(confineStoragePath("artifact", bad, ws, nw, rewrite)).toBeNull()
    }
    // A rewrite that fails to land in the new prefix is refused too.
    expect(confineStoragePath("artifact", `artifacts/${ws}/a/b`, ws, nw, (t) => t)).toBeNull()
  })
  it("capability pack artifacts must be the digest's own content-addressed path", () => {
    const sha = "a".repeat(64)
    expect(capabilityPackArtifactPath(`capability-packs/sha256/${sha}.json`, sha)).toBe(`capability-packs/sha256/${sha}.json`)
    expect(capabilityPackArtifactPath(`capability-packs/sha256/${"b".repeat(64)}.json`, sha)).toBeNull()
    expect(capabilityPackArtifactPath(`../x`, sha)).toBeNull()
  })
  it("recognises only this deployment's feedback URLs", () => {
    expect(isOwnFeedbackAttachmentUrl(OWN_FEEDBACK_URL, srcWs)).toBe(true)
    expect(isOwnFeedbackAttachmentUrl(OWN_FEEDBACK_URL, victimWs)).toBe(false) // another workspace's attachment
    expect(isOwnFeedbackAttachmentUrl(`https://${STORE_HOST}/branding/${randomUUID()}-logo.png`, srcWs)).toBe(false)
    expect(isOwnFeedbackAttachmentUrl("https://evil.example/feedback/a.png", srcWs)).toBe(false)
    expect(isOwnFeedbackAttachmentUrl("http://169.254.169.254/", srcWs)).toBe(false)
    expect(isOwnFeedbackAttachmentUrl(OWN_FEEDBACK_URL.replace(STORE_HOST, "other.public.blob.vercel-storage.com"), srcWs)).toBe(false) // another Blob store
    expect(isOwnFeedbackAttachmentUrl(OWN_FEEDBACK_URL.replace("https:", "http:"), srcWs)).toBe(false)
    expect(isOwnFeedbackAttachmentUrl(null, srcWs)).toBe(false)
  })
})
