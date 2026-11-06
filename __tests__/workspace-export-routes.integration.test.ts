/**
 * Workspace export/import at the HTTP boundary: real route handlers, real PostgreSQL schema, only auth() mocked.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { unzipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"

process.env.DATABASE_URL ??= process.env.WORKSPACE_EXPORT_DATABASE_URL
delete process.env.VERCEL

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null, userId: null as string | null }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))
vi.mock("@/auth", () => ({ auth: async () => (connection.userId ? { user: { id: connection.userId, email: "x@localhost.dev" } } : null) }))
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))

const { GET: exportRoute } = await import("@/app/api/workspace-export/[orgSlug]/[workspaceSlug]/route")
const { POST: importRoute } = await import("@/app/api/workspace-import/[orgSlug]/route")
const { POST: prepareRoute } = await import("@/app/api/workspace-import/[orgSlug]/prepare/route")
const { prepareBundleUpload, verifyBundleReceipt } = await import("@/lib/workspace-export/upload")

const databaseUrl = process.env.WORKSPACE_EXPORT_DATABASE_URL

describe.skipIf(!databaseUrl)("workspace export/import routes", () => {
  const schema = `wxr_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let adminId: string
  let memberId: string
  let outsiderId: string
  let wsId: string

  const orgParams = (orgSlug: string) => ({ params: Promise.resolve({ orgSlug }) })
  const wsParams = (orgSlug: string, workspaceSlug: string) => ({ params: Promise.resolve({ orgSlug, workspaceSlug }) })

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Requires isolated local compass_e2e")
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 120_000 })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient
    connection.prisma = prisma

    const org = await prisma.organization.create({ data: { slug: "route-org", name: "Route Org" } })
    const admin = await prisma.user.create({ data: { email: "admin@x.dev", name: "Admin" } })
    const member = await prisma.user.create({ data: { email: "member@x.dev", name: "Member" } })
    const outsider = await prisma.user.create({ data: { email: "out@x.dev", name: "Out" } })
    adminId = admin.id
    memberId = member.id
    outsiderId = outsider.id
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: adminId, role: "ADMIN" } })
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: memberId, role: "MEMBER" } })
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, slug: "src", name: "Src" } })
    wsId = ws.id
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: adminId, role: "ADMIN" } })
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: memberId, role: "MEMBER" } })
    await prisma.opportunity.create({ data: { workspaceId: ws.id, title: "Route opp", createdById: adminId } })
  }, 180_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await pool.end()
    }
  })

  it("export: 401 anonymous, 404 non-member, 403 plain member, 200 zip for admin", async () => {
    connection.userId = null
    expect((await exportRoute(new Request("http://x"), wsParams("route-org", "src"))).status).toBe(401)
    connection.userId = outsiderId
    expect((await exportRoute(new Request("http://x"), wsParams("route-org", "src"))).status).toBe(404)
    connection.userId = memberId
    expect((await exportRoute(new Request("http://x"), wsParams("route-org", "src"))).status).toBe(403)
    connection.userId = adminId
    const res = await exportRoute(new Request("http://x"), wsParams("route-org", "src"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/zip")
    expect(res.headers.get("content-disposition")).toMatch(/src-\d{4}-\d{2}-\d{2}\.compass\.zip/)
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    expect(Object.keys(files)).toContain("manifest.json")
    expect(new TextDecoder().decode(files["data/Opportunity.0000.ndjson"])).toContain("Route opp")
  })

  it("import: org admins only; imports a downloaded bundle as a new workspace; same nonce is idempotent", async () => {
    connection.userId = adminId
    const bundle = new Uint8Array(await (await exportRoute(new Request("http://x"), wsParams("route-org", "src"))).arrayBuffer())
    const post = (userId: string | null, nonce = "r1") => {
      connection.userId = userId
      const form = new FormData()
      form.set("file", new File([bundle as BlobPart], "b.zip", { type: "application/zip" }))
      form.set("nonce", nonce)
      form.set("slug", "from-route")
      return importRoute(new Request("http://x", { method: "POST", body: form }), orgParams("route-org"))
    }
    expect((await post(null)).status).toBe(401)
    expect((await post(memberId)).status).toBe(403)
    const ok = await post(adminId)
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.ok).toBe(true)
    expect(body.slug).toBe("from-route")
    expect(await prisma.opportunity.count({ where: { workspaceId: body.workspaceId, title: "Route opp" } })).toBe(1)
    const again = await (await post(adminId)).json()
    expect(again.alreadyImported).toBe(true)
    expect(again.workspaceId).toBe(body.workspaceId)
    expect(await prisma.opportunity.count({ where: { title: "Route opp" } })).toBe(2)
  }, 120_000)

  it("import: rejects a non-bundle with 422 and a missing file with 400", async () => {
    connection.userId = adminId
    const form = new FormData()
    form.set("file", new File([new Uint8Array([1, 2, 3])], "x.zip"))
    expect((await importRoute(new Request("http://x", { method: "POST", body: form }), orgParams("route-org"))).status).toBe(422)
    expect((await importRoute(new Request("http://x", { method: "POST", body: new FormData() }), orgParams("route-org"))).status).toBe(400)
  })

  it("prepare: multipart mode locally; auth enforced", async () => {
    const call = (userId: string | null) => {
      connection.userId = userId
      return prepareRoute(new Request("http://x", { method: "POST", body: JSON.stringify({ fileSize: 1000 }), headers: { "Content-Type": "application/json" } }), orgParams("route-org"))
    }
    expect((await call(memberId)).status).toBe(403)
    const res = await call(adminId)
    expect(await res.json()).toEqual({ mode: "multipart" })
  })

  it("upload receipts are signed, scoped to org and user, and expire", async () => {
    process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_secret"
    const prepared = await prepareBundleUpload({ organizationId: "org-1", userId: "user-1", fileSize: 10 }, 1_000)
    expect(prepared.pathname).toBe(`workspace-import-staging/org-1/${prepared.uploadId}.zip`)
    expect(verifyBundleReceipt(prepared.receipt, "org-1", "user-1", 2_000).fileSize).toBe(10)
    expect(() => verifyBundleReceipt(prepared.receipt, "org-2", "user-1", 2_000)).toThrow(/does not belong/)
    expect(() => verifyBundleReceipt(prepared.receipt, "org-1", "user-2", 2_000)).toThrow(/does not belong/)
    expect(() => verifyBundleReceipt(prepared.receipt + "x", "org-1", "user-1", 2_000)).toThrow(/Invalid/)
    expect(() => verifyBundleReceipt(prepared.receipt, "org-1", "user-1", 1_000 + 31 * 60 * 1000)).toThrow(/expired/)
    delete process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN
  })
})
