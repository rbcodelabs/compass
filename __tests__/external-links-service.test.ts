import type { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"

// The transaction wrapper needs a real client; here the work simply runs against the in-memory fake.
vi.mock("@/lib/typed-links", async function (importOriginal) {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    runTypedLinkTransaction: async function (prisma: unknown, work: (tx: unknown) => Promise<unknown>) {
      return work(prisma)
    },
  }
})

import {
  ExternalLinkError,
  MAX_EXTERNAL_LINKS_PER_SUBJECT,
  addExternalLink,
  deleteWorkspaceExternalLinks,
  findSubjectsByExternalKey,
  listExternalLinks,
  removeExternalLink,
} from "@/lib/external-links-service"

type Row = Record<string, unknown>

function matches(row: Row, where: Row): boolean {
  for (const key of Object.keys(where)) {
    const want = where[key]
    if (want && typeof want === "object" && "in" in (want as Row)) {
      if (!((want as Row).in as unknown[]).includes(row[key])) return false
    } else if (row[key] !== want) {
      return false
    }
  }
  return true
}

function makeDb(seed: { solutions?: Row[]; tasks?: Row[]; links?: Row[] }) {
  const links: Row[] = [...(seed.links ?? [])]
  let counter = 0
  const finder = function (rows: Row[]) {
    return async function (args: { where: Row }) {
      return rows.find(function (row) {
        return matches(row, args.where)
      }) ?? null
    }
  }
  return {
    links,
    $queryRaw: async function (query: Prisma.Sql) {
      const subjects = query.sql.includes('."solutions"') ? seed.solutions : seed.tasks
      const [id, workspaceId] = query.values
      return (subjects ?? []).filter(row => matches(row, { id, workspaceId }))
    },
    solution: { findFirst: finder(seed.solutions ?? []) },
    task: { findFirst: finder(seed.tasks ?? []) },
    externalLink: {
      findFirst: async function (args: { where: Row }) {
        return links.find(function (row) {
          return matches(row, args.where)
        }) ?? null
      },
      count: async function (args: { where: Row }) {
        return links.filter(function (row) {
          return matches(row, args.where)
        }).length
      },
      create: async function (args: { data: Row }) {
        counter += 1
        const row = { id: "link-" + counter, ...args.data }
        links.push(row)
        return row
      },
      findMany: async function (args: { where: Row; take?: number }) {
        const found = links.filter(function (row) {
          return matches(row, args.where)
        })
        return found.slice(0, args.take ?? found.length)
      },
      deleteMany: async function (args: { where: Row }) {
        let removed = 0
        for (let i = links.length - 1; i >= 0; i -= 1) {
          if (matches(links[i], args.where)) {
            links.splice(i, 1)
            removed += 1
          }
        }
        return { count: removed }
      },
    },
  }
}

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const SOLUTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function fresh(extra?: { links?: Row[] }) {
  return makeDb({ solutions: [{ id: SOLUTION, workspaceId: WS }], tasks: [{ id: TASK, workspaceId: WS }], links: extra?.links })
}

async function failure(promise: Promise<unknown>): Promise<ExternalLinkError> {
  try {
    await promise
  } catch (error) {
    return error as ExternalLinkError
  }
  throw new Error("expected a rejection")
}

describe("addExternalLink", function () {
  it("creates a link with a rebuilt URL, a derived title and the provider default relation", async function () {
    const db = fresh()
    const result = await addExternalLink(db as never, { workspaceId: WS, subjectType: "SOLUTION", subjectId: SOLUTION, url: "https://github.com/Acme/Web/pull/482/files#x", createdById: "u1" })
    expect(result.created).toBe(true)
    expect(result.link).toMatchObject({
      workspaceId: WS,
      subjectType: "SOLUTION",
      subjectId: SOLUTION,
      provider: "GITHUB_PR",
      url: "https://github.com/Acme/Web/pull/482",
      externalKey: "acme/web#482",
      title: "Acme/Web #482",
      relation: "IMPLEMENTS",
      source: "UI",
      createdById: "u1",
    })
  })

  it("is idempotent: the same PR in another spelling returns the existing link", async function () {
    const db = fresh()
    const first = await addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://github.com/acme/web/pull/7" })
    const again = await addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://github.com/ACME/WEB/pull/7/commits" })
    expect(again.created).toBe(false)
    expect(again.link.id).toBe(first.link.id)
    expect(db.links.length).toBe(1)
  })

  it("lets the caller choose the relation, title and source", async function () {
    const db = fresh()
    const result = await addExternalLink(db as never, {
      workspaceId: WS,
      subjectType: "TASK",
      subjectId: TASK,
      url: "https://example.com/spec",
      relation: "DOCS",
      title: "  Launch spec  ",
      source: "AGENT",
    })
    expect(result.link).toMatchObject({ provider: "OTHER", relation: "DOCS", title: "Launch spec", source: "AGENT" })
  })

  it("rejects an unusable URL, relation or subject type without writing", async function () {
    const db = fresh()
    expect((await failure(addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "javascript:alert(1)" }))).code).toBe("INVALID_URL")
    expect((await failure(addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://example.com/a", relation: "NOPE" }))).code).toBe("INVALID_INPUT")
    expect((await failure(addExternalLink(db as never, { workspaceId: WS, subjectType: "OPPORTUNITY", subjectId: TASK, url: "https://example.com/a" }))).code).toBe("INVALID_INPUT")
    expect(db.links.length).toBe(0)
  })

  it("refuses a subject from another workspace and writes nothing", async function () {
    const db = fresh()
    const error = await failure(addExternalLink(db as never, { workspaceId: OTHER_WS, subjectType: "SOLUTION", subjectId: SOLUTION, url: "https://example.com/a" }))
    expect(error).toBeInstanceOf(ExternalLinkError)
    expect(error.code).toBe("NOT_FOUND")
    expect(db.links.length).toBe(0)
  })

  it("caps the links on one subject", async function () {
    const seeded: Row[] = []
    for (let i = 0; i < MAX_EXTERNAL_LINKS_PER_SUBJECT; i += 1) {
      seeded.push({ id: "s" + i, workspaceId: WS, subjectType: "TASK", subjectId: TASK, provider: "OTHER", externalKey: "https://example.com/" + i })
    }
    const db = fresh({ links: seeded })
    const error = await failure(addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://example.com/new" }))
    expect(error.code).toBe("TOO_MANY")
    expect(db.links.length).toBe(MAX_EXTERNAL_LINKS_PER_SUBJECT)
  })
})

describe("reads and removal", function () {
  it("lists only the links on that subject in that workspace", async function () {
    const db = fresh()
    await addExternalLink(db as never, { workspaceId: WS, subjectType: "SOLUTION", subjectId: SOLUTION, url: "https://github.com/acme/web/pull/1" })
    await addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://github.com/acme/web/pull/2" })
    const listed = await listExternalLinks(db as never, WS, "SOLUTION", SOLUTION)
    expect(listed.map(function (row) { return row.externalKey })).toEqual(["acme/web#1"])
    expect(await listExternalLinks(db as never, OTHER_WS, "SOLUTION", SOLUTION)).toEqual([])
  })

  it("finds every subject that links to one PR, scoped to the workspace", async function () {
    const db = fresh()
    await addExternalLink(db as never, { workspaceId: WS, subjectType: "SOLUTION", subjectId: SOLUTION, url: "https://github.com/acme/web/pull/9" })
    await addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://github.com/acme/web/pull/9" })
    expect((await findSubjectsByExternalKey(db as never, WS, "GITHUB_PR", "acme/web#9")).length).toBe(2)
    expect(await findSubjectsByExternalKey(db as never, OTHER_WS, "GITHUB_PR", "acme/web#9")).toEqual([])
  })

  it("removes a link only inside its own workspace", async function () {
    const db = fresh()
    const added = await addExternalLink(db as never, { workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://example.com/a" })
    expect(await removeExternalLink(db as never, OTHER_WS, added.link.id)).toBe(0)
    expect(db.links.length).toBe(1)
    expect(await removeExternalLink(db as never, WS, added.link.id)).toBe(1)
    expect(db.links.length).toBe(0)
  })
})

describe("deleteWorkspaceExternalLinks", function () {
  it("purges one workspace across several passes and leaves others alone", async function () {
    const seeded: Row[] = []
    for (let i = 0; i < 1200; i += 1) seeded.push({ id: "mine" + i, workspaceId: WS, subjectType: "TASK", subjectId: TASK, provider: "OTHER", externalKey: "k" + i })
    seeded.push({ id: "theirs", workspaceId: OTHER_WS, subjectType: "TASK", subjectId: TASK, provider: "OTHER", externalKey: "k" })
    const db = fresh({ links: seeded })
    expect(await deleteWorkspaceExternalLinks(db as never, WS)).toBe(1200)
    expect(db.links.map(function (row) { return row.id })).toEqual(["theirs"])
  })
})

describe("external-key digest integrity", () => {
  it("stores a fixed-width hex digest without truncating a 1000-byte URL", async () => {
    const db = fresh()
    const url = "https://example.com/" + "a".repeat(1000 - "https://example.com/".length)
    const added = await addExternalLink(db as never, {workspaceId: WS, subjectType: "TASK", subjectId: TASK, url})
    expect(added.link.externalKey).toBe(url)
    expect(db.links[0].externalKeyHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it("fails closed when the digest lookup finds a different full key", async () => {
    const db = fresh()
    db.externalLink.findFirst = async () => ({id: "collision", workspaceId: WS, externalKey: "different"})
    await expect(addExternalLink(db as never, {workspaceId: WS, subjectType: "TASK", subjectId: TASK, url: "https://example.com/a"})).rejects.toThrow(/collision/i)
    expect(db.links).toHaveLength(0)
  })
})
