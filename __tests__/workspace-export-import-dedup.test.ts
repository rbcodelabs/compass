import { randomUUID } from "node:crypto"
import { zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import type { BlobAdapters } from "@/lib/workspace-export/blobs"
import { BundleReader } from "@/lib/workspace-export/bundle"
import { exportWorkspaceToBuffer } from "@/lib/workspace-export/export"
import { importWorkspaceBundle } from "@/lib/workspace-export/import"
import { UNIQUE_KEYS } from "@/lib/workspace-export/schema-meta.generated"
import { delegateKey, dmmfModels } from "@/lib/workspace-export/scope"

type Row = Record<string, unknown>

const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normVal(v: unknown): unknown {
  if (typeof v === "string" && UUID_EXACT.test(v)) return v.toLowerCase()
  if (v instanceof Date) return v.getTime()
  return v
}

function createInMemoryPrisma(seed: Record<string, Row[]> = {}) {
  const modelByDelegate = new Map([...dmmfModels.keys()].map((m) => [delegateKey(m), m]))
  const tables: Record<string, Row[]> = {}
  for (const [model, rows] of Object.entries(seed)) {
    tables[model] = rows.map((r) => ({ ...r }))
  }

  const matches = (row: Row, where?: Row): boolean => {
    if (!where) return true
    return Object.entries(where).every(([key, cond]) => {
      const val = row[key] ?? null
      if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
        if ("in" in cond) {
          const list = (cond as { in: unknown[] }).in.map(normVal)
          return list.includes(normVal(val))
        }
        if ("lt" in cond) {
          return typeof val === "number" && val < ((cond as { lt: number }).lt)
        }
      }
      return normVal(val) === normVal(cond ?? null)
    })
  }

  const conflictsWithExisting = (model: string, existing: Row[], candidate: Row): boolean => {
    if (typeof candidate.id === "string" && existing.some((r) => normVal(r.id) === normVal(candidate.id))) {
      return true
    }
    for (const cols of UNIQUE_KEYS[model] ?? []) {
      if (cols.some((c) => candidate[c] === null || candidate[c] === undefined)) continue
      const hit = existing.some(
        (r) =>
          cols.every((c) => r[c] !== null && r[c] !== undefined) &&
          cols.every((c) => normVal(r[c]) === normVal(candidate[c])),
      )
      if (hit) return true
    }
    return false
  }

  const makeDelegate = (dKey: string) => {
    const model = modelByDelegate.get(dKey) ?? dKey
    const rows = () => (tables[model] ??= [])
    return {
      async findMany(args: {
        where?: Row
        take?: number
        cursor?: { id: string }
        skip?: number
        orderBy?: { id?: "asc" | "desc" }
        select?: Record<string, boolean>
      } = {}) {
        let list = rows().filter((r) => matches(r, args.where))
        if (args.orderBy?.id === "asc") {
          list = [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        }
        if (args.cursor?.id) {
          const idx = list.findIndex((r) => normVal(r.id) === normVal(args.cursor!.id))
          list = idx >= 0 ? list.slice(idx + (args.skip ?? 0)) : []
        }
        if (args.take !== undefined) list = list.slice(0, args.take)
        return list.map((r) => {
          if (!args.select) return { ...r }
          return Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, r[k] ?? null]))
        })
      },
      async count(args: { where?: Row } = {}) {
        return rows().filter((r) => matches(r, args.where)).length
      },
      async aggregate(args: { where?: Row; _max?: { seqNumber?: boolean } }) {
        const list = rows().filter((r) => matches(r, args.where))
        const nums = list.map((r) => r.seqNumber).filter((n): n is number => typeof n === "number")
        return { _max: { seqNumber: nums.length ? Math.max(...nums) : null } }
      },
      async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
        const table = rows()
        let count = 0
        for (const item of args.data) {
          if (conflictsWithExisting(model, table, item)) {
            if (args.skipDuplicates) continue
            throw Object.assign(new Error(`Unique constraint failed on ${model}`), { code: "P2002" })
          }
          table.push({ ...item })
          count++
        }
        return { count }
      },
      async updateMany(args: { where?: Row; data: Row }) {
        let count = 0
        for (const r of rows()) {
          if (matches(r, args.where)) {
            Object.assign(r, args.data)
            count++
          }
        }
        return { count }
      },
      async deleteMany(args: { where?: Row } = {}) {
        const table = rows()
        const kept = table.filter((r) => !matches(r, args.where))
        const count = table.length - kept.length
        tables[model] = kept
        return { count }
      },
    }
  }

  const client: Record<string, unknown> = new Proxy(
    {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(client)
      },
    },
    {
      get(target, prop: string) {
        if (prop in target) return target[prop as keyof typeof target]
        return makeDelegate(prop)
      },
    },
  )

  return { client, tables }
}

const noopBlobs: BlobAdapters = {
  artifact: {
    async put(p) {
      return { pathname: p }
    },
    async get() {
      return null
    },
    async del() {},
  },
  research: {
    async put(p) {
      return { pathname: p }
    },
    async get() {
      return null
    },
    async del() {},
  },
  async fetchPublic() {
    return null
  },
  async putPublic(p) {
    return `https://public.example/${p}`
  },
  async delPublic() {},
}

it("aborts an import when the existing private file differs from the bundle", async () => {
  const orgId = randomUUID()
  const wsId = randomUUID()
  const importerId = randomUUID()
  const db = createInMemoryPrisma({
    Organization: [{ id: orgId, slug: "org", name: "Org" }],
    User: [{ id: importerId, email: "importer@example.com", name: "Importer" }],
    OrganizationMember: [{ id: randomUUID(), organizationId: orgId, userId: importerId, role: "ADMIN" }],
    Workspace: [{ id: wsId, organizationId: orgId, slug: "source", name: "Source", ssoEnabled: false }],
    Doc: [{ id: randomUUID(), workspaceId: wsId, title: "Doc", content: `![image](/api/docs/images/${wsId}/${randomUUID()}.png)` }],
  })
  const bundle = await exportWorkspaceToBuffer(db.client, wsId, {
    ...noopBlobs, artifact: { ...noopBlobs.artifact, get: async () => new Uint8Array([1]) },
  })
  const deleted: string[] = []
  const artifact = {
    put: async (pathname: string) => ({ pathname, created: false }),
    get: async () => new Uint8Array([2]),
    del: async (pathname: string) => { deleted.push(pathname) },
  }
  await expect(importWorkspaceBundle(db.client, bundle, {
    organizationId: orgId, importerUserId: importerId, slug: "copy", blobs: { ...noopBlobs, artifact },
  })).rejects.toThrow(/existing private file differs/i)
  expect(deleted).toEqual([])
  expect(db.tables.Workspace).toHaveLength(1)
})

it.each(["S3", "Blob"])("%s does not give an imported workspace ownership of a source attachment when no bytes were bundled", async (backend) => {
  const orgId = randomUUID()
  const wsId = randomUUID()
  const importerId = randomUUID()
  const feedbackItemId = randomUUID()
  const attachmentId = randomUUID()
  const db = createInMemoryPrisma({
    Organization: [{ id: orgId, slug: "org", name: "Org" }],
    User: [{ id: importerId, email: "importer@example.com", name: "Importer" }],
    OrganizationMember: [{ id: randomUUID(), organizationId: orgId, userId: importerId, role: "ADMIN" }],
    Workspace: [{ id: wsId, organizationId: orgId, slug: "source", name: "Source", ssoEnabled: false }],
    FeedbackItem: [{ id: feedbackItemId, workspaceId: wsId, title: "Feedback" }],
    FeedbackAttachment: [{
      id: attachmentId, feedbackItemId, filename: "file.png", fileType: "image/png", fileSize: 1,
      url: backend === "S3"
        ? `/api/files/public/feedback/${wsId}/${attachmentId}-file.png`
        : `https://fixture.public.blob.vercel-storage.com/feedback/${wsId}/${attachmentId}-file.png`,
    }],
  })
  const bundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
  const report = await importWorkspaceBundle(db.client, bundle, {
    organizationId: orgId, importerUserId: importerId, slug: "copy", blobs: noopBlobs,
  })
  expect(report.warnings.join("\n")).toMatch(/attachment.*had no bytes.*skipped/i)
  expect(db.tables.FeedbackAttachment).toHaveLength(1)
})

it("clears S3 logos and embed screenshots whose bytes were not bundled", async () => {
  const orgId = randomUUID()
  const wsId = randomUUID()
  const importerId = randomUUID()
  const feedbackItemId = randomUUID()
  const attachmentId = randomUUID()
  const screenshotUrl = `/api/files/public/embed-feedback/${wsId}/source/capture-${attachmentId}.png`
  const db = createInMemoryPrisma({
    Organization: [{ id: orgId, slug: "org", name: "Org" }],
    User: [{ id: importerId, email: "importer@example.com", name: "Importer" }],
    OrganizationMember: [{ id: randomUUID(), organizationId: orgId, userId: importerId, role: "ADMIN" }],
    Workspace: [{ id: wsId, organizationId: orgId, slug: "source", name: "Source", ssoEnabled: false, brandingLogoUrl: `/api/files/public/branding/${attachmentId}-logo.png` }],
    FeedbackItem: [{ id: feedbackItemId, workspaceId: wsId, title: "Feedback" }],
    FeedbackElementAnchor: [{ feedbackItemId, feedbackSourceId: "source", pageUrl: "https://fixture.example/", pagePath: "/", screenshotUrl }],
  })
  const bundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
  const report = await importWorkspaceBundle(db.client, bundle, {
    organizationId: orgId, importerUserId: importerId, slug: "copy", blobs: noopBlobs,
  })
  expect(report.warnings.join("\n")).toMatch(/branding logo/i)
  expect(report.warnings.join("\n")).toMatch(/embed screenshot/i)
  expect(db.tables.Workspace.find((row) => row.id === report.workspaceId)?.brandingLogoUrl).toBeNull()
  expect(db.tables.FeedbackElementAnchor.find((row) => row.feedbackItemId !== feedbackItemId)?.screenshotUrl).toBeNull()
})

it("returns a committed retry before checking its occupied slug", async () => {
  const orgId = randomUUID()
  const wsId = randomUUID()
  const importerId = randomUUID()
  const db = createInMemoryPrisma({
    Organization: [{ id: orgId, slug: "org", name: "Org" }],
    User: [{ id: importerId, email: "importer@example.com", name: "Importer" }],
    OrganizationMember: [{ id: randomUUID(), organizationId: orgId, userId: importerId, role: "ADMIN" }],
    Workspace: [{ id: wsId, organizationId: orgId, slug: "source", name: "Source", ssoEnabled: false }],
    Doc: [{ id: randomUUID(), workspaceId: wsId, title: "Doc", content: `![image](/api/docs/images/${wsId}/${randomUUID()}.png)` }],
  })
  const bundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
  const opts = { organizationId: orgId, importerUserId: importerId, slug: "copy", nonce: "one-import", blobs: {
    ...noopBlobs, claimImport: async () => async () => undefined,
  } }
  const workspace = db.client.workspace as { findMany: (args: unknown) => Promise<Row[]> }
  db.client.workspace = {
    ...workspace,
    findMany: vi.fn(workspace.findMany).mockImplementationOnce(async () => {
      const client = new Proxy(db.client, { get: (target, prop) => prop === "workspace" ? workspace : Reflect.get(target, prop) })
      await importWorkspaceBundle(client, bundle, opts)
      return []
    }),
  }
  await expect(importWorkspaceBundle(db.client, bundle, opts)).resolves.toMatchObject({ alreadyImported: true, slug: "copy" })
})

it("reserves an import identity before either invocation writes bundle assets", async () => {
  const orgId = randomUUID()
  const wsId = randomUUID()
  const importerId = randomUUID()
  const db = createInMemoryPrisma({
    Organization: [{ id: orgId, slug: "org", name: "Org" }],
    User: [{ id: importerId, email: "importer@example.com", name: "Importer" }],
    OrganizationMember: [{ id: randomUUID(), organizationId: orgId, userId: importerId, role: "ADMIN" }],
    Workspace: [{ id: wsId, organizationId: orgId, slug: "source", name: "Source", ssoEnabled: false }],
    Doc: [{ id: randomUUID(), workspaceId: wsId, title: "Doc", content: `![image](/api/docs/images/${wsId}/${randomUUID()}.png)` }],
  })
  const artifact = { ...noopBlobs.artifact, get: async () => new Uint8Array([1]) }
  const bundle = await exportWorkspaceToBuffer(db.client, wsId, { ...noopBlobs, artifact })
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const put = vi.fn(async (pathname: string) => {
    if (put.mock.calls.length > 1) throw new Error("unexpected second writer")
    entered.resolve()
    await resume.promise
    return { pathname, created: true }
  })
  let claimed = false
  const claimImport = async () => {
    if (claimed) throw new Error("import already in progress")
    claimed = true
    return async () => { claimed = false }
  }
  const blobs = { ...noopBlobs, artifact: { ...artifact, put }, claimImport }
  const opts = { organizationId: orgId, importerUserId: importerId, slug: "copy", nonce: "one-import", blobs }
  const initial = importWorkspaceBundle(db.client, bundle, opts)
  await entered.promise
  try {
    await expect(importWorkspaceBundle(db.client, bundle, opts)).rejects.toThrow("import already in progress")
  } finally {
    resume.resolve()
    await initial
  }
  await expect(importWorkspaceBundle(db.client, bundle, opts)).resolves.toMatchObject({ alreadyImported: true })
  expect(put).toHaveBeenCalledOnce()
  expect(claimed).toBe(false)
})

describe("importWorkspaceBundle unique-key deduplication on collapsed users", () => {
  it("deduplicates CardSortProposal and Follow rows when 5 unmatched source users collapse onto the importer", async () => {
    const srcOrgId = randomUUID()
    const dstOrgId = randomUUID()
    const wsId = randomUUID()
    const importerId = randomUUID()
    const sourceUsers = Array.from({ length: 5 }, (_, i) => ({
      id: randomUUID(),
      email: `user${i + 1}@source-only.example`,
      name: `User ${i + 1}`,
    }))
    const opps = Array.from({ length: 6 }, (_, i) => ({
      id: randomUUID(),
      workspaceId: wsId,
      title: `Opportunity ${i + 1}`,
      createdById: sourceUsers[i % sourceUsers.length].id,
      seqPrefix: "OPP",
      seqNumber: i + 1,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    }))
    const fieldId = randomUUID()
    const roundId = randomUUID()

    // 24 distinct (roundId, userId, objectId) proposals across 5 source users and 6 opportunities:
    // opportunities 0..3 get all 5 users (20 rows), opportunities 4..5 get 2 users each (4 rows) = 24 rows total.
    const proposals: Row[] = []
    for (let oi = 0; oi < 6; oi++) {
      const voterCount = oi < 4 ? 5 : 2
      for (let ui = 0; ui < voterCount; ui++) {
        proposals.push({
          id: randomUUID(),
          roundId,
          userId: sourceUsers[ui].id,
          objectId: opps[oi].id,
          proposedValue: ui % 2 === 0 ? "now" : "later",
          fromValue: null,
          rationale: `Vote from user ${ui + 1}`,
          createdAt: new Date("2026-01-02T00:00:00Z"),
          updatedAt: new Date("2026-01-02T00:00:00Z"),
        })
      }
    }
    expect(proposals).toHaveLength(24)

    // All 5 unmatched users also follow opps[0]; Follow has workspaceId + id, exercising pre-commit count validation.
    const follows: Row[] = sourceUsers.map((u) => ({
      id: randomUUID(),
      workspaceId: wsId,
      userId: u.id,
      subjectType: "OPPORTUNITY",
      subjectId: opps[0].id,
      state: "FOLLOWING",
      source: "MANUAL",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    }))

    const db = createInMemoryPrisma({
      Organization: [
        { id: srcOrgId, slug: "src-org", name: "Source Org" },
        { id: dstOrgId, slug: "dst-org", name: "Target Org" },
      ],
      User: [...sourceUsers, { id: importerId, email: "importer@target.example", name: "Importer" }],
      OrganizationMember: [
        ...sourceUsers.map((u) => ({ id: randomUUID(), organizationId: srcOrgId, userId: u.id, role: "MEMBER" })),
        { id: randomUUID(), organizationId: dstOrgId, userId: importerId, role: "ADMIN" },
      ],
      Workspace: [{ id: wsId, organizationId: srcOrgId, slug: "product", name: "Product", ssoEnabled: false }],
      Opportunity: opps,
      CustomFieldDefinition: [
        {
          id: fieldId,
          workspaceId: wsId,
          objectType: "OPPORTUNITY",
          name: "Horizon",
          fieldType: "SELECT",
          options: [{ label: "Now", value: "now" }, { label: "Later", value: "later" }],
          order: 0,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      CardSortRound: [
        {
          id: roundId,
          workspaceId: wsId,
          name: "Q1 Sort",
          objectType: "OPPORTUNITY",
          fieldDefinitionId: fieldId,
          status: "OPEN",
          createdById: sourceUsers[0].id,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      CardSortProposal: proposals,
      Follow: follows,
    })

    const bundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
    const report = await importWorkspaceBundle(db.client, bundle, {
      organizationId: dstOrgId,
      importerUserId: importerId,
      blobs: noopBlobs,
      nonce: "issue-552",
    })

    expect(report.alreadyImported).toBe(false)
    expect(report.usersMatched).toBe(0)
    expect(report.usersFallbackToImporter).toBe(5)
    expect(report.counts.CardSortProposal).toBe(6)
    expect(report.counts.Follow).toBe(1)
    expect(report.warnings).toContain(
      "Skipped 18 CardSortProposal row(s) that would duplicate another row once people without an account in this organization were attributed to you",
    )
    expect(report.warnings).toContain(
      "Skipped 4 Follow row(s) that would duplicate another row once people without an account in this organization were attributed to you",
    )

    const importedRound = db.tables.CardSortRound.find((r) => r.workspaceId === report.workspaceId)!
    const importedProposals = db.tables.CardSortProposal.filter((r) => r.roundId === importedRound.id)
    expect(importedProposals).toHaveLength(6)
    expect(importedProposals.every((p) => p.userId === importerId)).toBe(true)

    const importedFollows = db.tables.Follow.filter((r) => r.workspaceId === report.workspaceId)
    expect(importedFollows).toHaveLength(1)
    expect(importedFollows[0].userId).toBe(importerId)
  })

  it("keeps distinct rows for matched users while deduplicating unmatched users who collide with the importer", async () => {
    const srcOrgId = randomUUID()
    const dstOrgId = randomUUID()
    const wsId = randomUUID()
    const srcImporterId = randomUUID()
    const dstImporterId = randomUUID()
    const srcAliceId = randomUUID()
    const dstAliceId = randomUUID()
    const bobId = randomUUID()
    const carolId = randomUUID()
    const oppId = randomUUID()
    const fieldId = randomUUID()
    const roundId = randomUUID()

    const db = createInMemoryPrisma({
      Organization: [
        { id: srcOrgId, slug: "src", name: "Src" },
        { id: dstOrgId, slug: "dst", name: "Dst" },
      ],
      User: [
        { id: srcImporterId, email: "importer@shared.example", name: "Importer" },
        { id: dstImporterId, email: "importer@shared.example", name: "Importer" },
        { id: srcAliceId, email: "alice@shared.example", name: "Alice" },
        { id: dstAliceId, email: "alice@shared.example", name: "Alice" },
        { id: bobId, email: "bob@source-only.example", name: "Bob" },
        { id: carolId, email: "carol@source-only.example", name: "Carol" },
      ],
      OrganizationMember: [
        { id: randomUUID(), organizationId: srcOrgId, userId: srcImporterId, role: "ADMIN" },
        { id: randomUUID(), organizationId: srcOrgId, userId: srcAliceId, role: "MEMBER" },
        { id: randomUUID(), organizationId: srcOrgId, userId: bobId, role: "MEMBER" },
        { id: randomUUID(), organizationId: srcOrgId, userId: carolId, role: "MEMBER" },
        { id: randomUUID(), organizationId: dstOrgId, userId: dstImporterId, role: "ADMIN" },
        { id: randomUUID(), organizationId: dstOrgId, userId: dstAliceId, role: "MEMBER" },
      ],
      Workspace: [{ id: wsId, organizationId: srcOrgId, slug: "ws", name: "WS", ssoEnabled: false }],
      Opportunity: [{ id: oppId, workspaceId: wsId, title: "Opp", createdAt: new Date(), updatedAt: new Date() }],
      CustomFieldDefinition: [
        { id: fieldId, workspaceId: wsId, objectType: "OPPORTUNITY", name: "Priority", fieldType: "SELECT", options: [], order: 0, createdAt: new Date(), updatedAt: new Date() },
      ],
      CardSortRound: [
        { id: roundId, workspaceId: wsId, name: "Round", objectType: "OPPORTUNITY", fieldDefinitionId: fieldId, status: "OPEN", createdById: srcImporterId, createdAt: new Date(), updatedAt: new Date() },
      ],
      CardSortProposal: [srcImporterId, srcAliceId, bobId, carolId].map((uid) => ({
        id: randomUUID(),
        roundId,
        userId: uid,
        objectId: oppId,
        proposedValue: "p1",
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    })

    const bundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
    const report = await importWorkspaceBundle(db.client, bundle, {
      organizationId: dstOrgId,
      importerUserId: dstImporterId,
      blobs: noopBlobs,
      nonce: "mixed-match",
    })

    expect(report.usersMatched).toBe(2)
    expect(report.usersFallbackToImporter).toBe(2)
    expect(report.counts.CardSortProposal).toBe(2)
    expect(report.warnings).toContain(
      "Skipped 2 CardSortProposal row(s) that would duplicate another row once people without an account in this organization were attributed to you",
    )
    const importedRound = db.tables.CardSortRound.find((r) => r.workspaceId === report.workspaceId)!
    const userIds = db.tables.CardSortProposal.filter((r) => r.roundId === importedRound.id).map((r) => r.userId).sort()
    expect(userIds).toEqual([dstImporterId, dstAliceId].sort())
  })

  it("treats NULL parts in unique tuples as distinct and checks all constraints before recording seen tuples", async () => {
    const orgId = randomUUID()
    const wsId = randomUUID()
    const importerId = randomUUID()
    const rm1 = randomUUID()
    const rm2 = randomUUID()

    const db = createInMemoryPrisma({
      Organization: [{ id: orgId, slug: "org", name: "Org" }],
      User: [{ id: importerId, email: "importer@example.com", name: "Importer" }],
      OrganizationMember: [{ id: randomUUID(), organizationId: orgId, userId: importerId, role: "ADMIN" }],
      Workspace: [{ id: wsId, organizationId: orgId, slug: "docs-ws", name: "Docs WS", ssoEnabled: false }],
      RoadmapItem: [
        { id: rm1, workspaceId: wsId, title: "RM 1", seqPrefix: null, seqNumber: null, createdAt: new Date(), updatedAt: new Date() },
        { id: rm2, workspaceId: wsId, title: "RM 2", seqPrefix: null, seqNumber: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      Evidence: [
        { id: randomUUID(), workspaceId: wsId, sourceType: "interview", excerpt: "e1", findingKey: null, createdAt: new Date(), updatedAt: new Date() },
        { id: randomUUID(), workspaceId: wsId, sourceType: "interview", excerpt: "e2", findingKey: null, createdAt: new Date(), updatedAt: new Date() },
      ],
      Doc: [
        // Two docs with NULL roadmapItemId and NULL seqNumber: neither unique constraint on Doc should collide.
        { id: "00000000-0000-4000-8000-000000000001", workspaceId: wsId, title: "Null A", content: "", roadmapItemId: null, seqPrefix: null, seqNumber: null, createdAt: new Date(), updatedAt: new Date() },
        { id: "00000000-0000-4000-8000-000000000002", workspaceId: wsId, title: "Null B", content: "", roadmapItemId: null, seqPrefix: null, seqNumber: null, createdAt: new Date(), updatedAt: new Date() },
        // Doc 3 claims rm1 and DOC-1.
        { id: "00000000-0000-4000-8000-000000000003", workspaceId: wsId, title: "Doc 3", content: "", roadmapItemId: rm1, seqPrefix: "DOC", seqNumber: 1, createdAt: new Date(), updatedAt: new Date() },
        // Doc 5 claims rm2 and DOC-2 (will be ordered after Doc 4 once we inject Doc 4 into the bundle).
        { id: "00000000-0000-4000-8000-000000000005", workspaceId: wsId, title: "Doc 5", content: "", roadmapItemId: rm2, seqPrefix: "DOC", seqNumber: 2, createdAt: new Date(), updatedAt: new Date() },
      ],
      DocVersion: [
        { id: randomUUID(), docId: "00000000-0000-4000-8000-000000000004", title: "Orphan version", content: "v1", createdAt: new Date() },
        { id: randomUUID(), docId: "00000000-0000-4000-8000-000000000005", title: "Kept version", content: "v1", createdAt: new Date() },
      ],
    })

    const rawBundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
    const reader = new BundleReader(rawBundle)
    const files: Record<string, Uint8Array> = {}
    for (const n of reader.list("")) files[n] = reader.read(n)!

    // Inject Doc 4 between Doc 3 and Doc 5: Doc 4 has roadmapItemId = rm2 (constraint #1 passes)
    // AND seqNumber = 1 (constraint #2 collides with Doc 3!).
    // Rejecting Doc 4 on constraint #2 must NOT record rm2 in constraint #1's seen set, so Doc 5 still succeeds,
    // and DocVersion pointing to skipped Doc 4 is skipped cleanly too.
    const docEntry = reader.list("data/Doc.")[0]
    const docRows = reader
      .readText(docEntry)!
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row)
    const doc4: Row = {
      ...docRows[2],
      id: "00000000-0000-4000-8000-000000000004",
      title: "Doc 4 colliding on DOC-1",
      roadmapItemId: rm2,
      seqPrefix: "DOC",
      seqNumber: 1,
    }
    const updatedDocs = [docRows[0], docRows[1], docRows[2], doc4, docRows[3]]
    files[docEntry] = new TextEncoder().encode(updatedDocs.map((r) => JSON.stringify(r)).join("\n") + "\n")

    // Also include the DocVersion row for Doc 4 in the bundle so parent-skip cascade is exercised.
    const dvEntry = reader.list("data/DocVersion.")[0]
    const dvRows = reader
      .readText(dvEntry)!
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row)
    const dvForDoc4: Row = {
      ...dvRows[0],
      id: randomUUID(),
      docId: "00000000-0000-4000-8000-000000000004",
      title: "Orphan version",
    }
    const updatedDvs = [dvForDoc4, ...dvRows]
    files[dvEntry] = new TextEncoder().encode(updatedDvs.map((r) => JSON.stringify(r)).join("\n") + "\n")

    const manifest = reader.manifest()
    manifest.counts.Doc = updatedDocs.length
    manifest.counts.DocVersion = updatedDvs.length
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest))

    const report = await importWorkspaceBundle(db.client, zipSync(files), {
      organizationId: orgId,
      importerUserId: importerId,
      blobs: noopBlobs,
      nonce: "multi-constraint",
    })

    // RoadmapItems (2 with NULL seq), Evidence (2 with NULL findingKey), and Docs (Null A, Null B, Doc 3, Doc 5 = 4) all land.
    expect(report.counts.RoadmapItem).toBe(2)
    expect(report.counts.Evidence).toBe(2)
    expect(report.counts.Doc).toBe(4)
    expect(report.counts.DocVersion).toBe(1)
    const importedDocs = db.tables.Doc.filter((r) => r.workspaceId === report.workspaceId)
    expect(importedDocs.map((d) => d.title).sort()).toEqual(["Doc 3", "Doc 5", "Null A", "Null B"])
    expect(report.warnings).toContain(
      "Skipped 1 Doc row(s) that would duplicate another row once people without an account in this organization were attributed to you",
    )
  })

  it("tracks dropped (unresolved reference) and deduped (collapsed user) counts separately in validation and warnings", async () => {
    const srcOrgId = randomUUID()
    const dstOrgId = randomUUID()
    const wsId = randomUUID()
    const importerId = randomUUID()
    const u1 = { id: randomUUID(), email: "u1@src.example", name: "U1" }
    const u2 = { id: randomUUID(), email: "u2@src.example", name: "U2" }
    const oppId = randomUUID()

    const db = createInMemoryPrisma({
      Organization: [
        { id: srcOrgId, slug: "src", name: "Src" },
        { id: dstOrgId, slug: "dst", name: "Dst" },
      ],
      User: [u1, u2, { id: importerId, email: "importer@dst.example", name: "Importer" }],
      OrganizationMember: [
        { id: randomUUID(), organizationId: srcOrgId, userId: u1.id, role: "MEMBER" },
        { id: randomUUID(), organizationId: srcOrgId, userId: u2.id, role: "MEMBER" },
        { id: randomUUID(), organizationId: dstOrgId, userId: importerId, role: "ADMIN" },
      ],
      Workspace: [{ id: wsId, organizationId: srcOrgId, slug: "both", name: "Both", ssoEnabled: false }],
      Opportunity: [{ id: oppId, workspaceId: wsId, title: "Opp", createdAt: new Date(), updatedAt: new Date() }],
      Follow: [
        // Two unmatched users following oppId -> 1 kept, 1 deduped.
        { id: randomUUID(), workspaceId: wsId, userId: u1.id, subjectType: "OPPORTUNITY", subjectId: oppId, state: "FOLLOWING", source: "MANUAL", createdAt: new Date(), updatedAt: new Date() },
        { id: randomUUID(), workspaceId: wsId, userId: u2.id, subjectType: "OPPORTUNITY", subjectId: oppId, state: "FOLLOWING", source: "MANUAL", createdAt: new Date(), updatedAt: new Date() },
        // Third row points to an entity outside the workspace -> 1 dropped.
        { id: randomUUID(), workspaceId: wsId, userId: u1.id, subjectType: "OPPORTUNITY", subjectId: randomUUID(), state: "FOLLOWING", source: "MANUAL", createdAt: new Date(), updatedAt: new Date() },
      ],
    })

    const bundle = await exportWorkspaceToBuffer(db.client, wsId, noopBlobs)
    const report = await importWorkspaceBundle(db.client, bundle, {
      organizationId: dstOrgId,
      importerUserId: importerId,
      blobs: noopBlobs,
      nonce: "dropped-and-deduped",
    })

    expect(report.counts.Follow).toBe(1)
    expect(report.warnings).toContain("Skipped 1 Follow row(s) whose required reference or storage path does not resolve inside the bundle")
    expect(report.warnings).toContain(
      "Skipped 1 Follow row(s) that would duplicate another row once people without an account in this organization were attributed to you",
    )
  })
})
