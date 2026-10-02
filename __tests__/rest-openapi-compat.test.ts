import { createHash } from "node:crypto"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { TOOL_SCOPES } from "@/lib/mcp-tool-gates"
import { buildOpenApiDocument } from "@/lib/rest/openapi"
import { MCP_PARITY_CATALOG, MCP_REST_MAPPINGS } from "@/lib/rest/parity-manifest"
import { REST_ROUTES } from "@/lib/rest/registry"

describe("REST OpenAPI compatibility", () => {
  it("is a structurally complete OpenAPI 3.1 document", () => {
    const document = buildOpenApiDocument()
    expect(document.openapi).toBe("3.1.0")
    expect(document.components).toHaveProperty("securitySchemes.bearerAuth")
    for (const route of REST_ROUTES) {
      const operation = document.paths[route.path]?.[route.method.toLowerCase()] as Record<string, unknown>
      expect(operation?.operationId).toBe(route.operationId)
      expect(operation?.security).toEqual([{ bearerAuth: [route.scope] }])
      expect(operation?.responses).toBeDefined()
    }
  })

  it("compiles a generated client surface for every OpenAPI operation", () => {
    const document = buildOpenApiDocument()
    const methods = Object.entries(document.paths).flatMap(([path, item]) => Object.entries(item).map(([method, operation]) =>
      `export async function ${operation.operationId}(client: Client, input: Input = {}): Promise<unknown> { return client.request(${JSON.stringify(method.toUpperCase())}, ${JSON.stringify(path)}, input) }`,
    ))
    const source = `
      export type ProblemDetails = { type: string; title: string; status: number; detail: string; instance: string; code: string }
      export type Input = { params?: Record<string,string>; query?: Record<string,string|number>; body?: unknown }
      export interface Client { request(method: string, path: string, input: Input): Promise<unknown> }
      ${methods.join("\n")}
      async function representative(client: Client) {
        await getCurrentIdentity(client)
        await listOpportunities(client, { params: { workspaceId: "id" }, query: { limit: 1 } })
        await createOpportunity(client, { params: { workspaceId: "id" }, body: { title: "Customer need" } })
        const problem: ProblemDetails = { type: "about:blank", title: "Invalid", status: 422, detail: "Invalid", instance: "/api/v1", code: "VALIDATION_FAILED" }
        return problem
      }
      void representative
    `
    const output = ts.transpileModule(source, { compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
    expect(output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []).toEqual([])
  })

  it("fails when the MCP catalog changes without a parity-ledger revision", () => {
    const names = Object.keys(TOOL_SCOPES).sort()
    expect(names).toHaveLength(MCP_PARITY_CATALOG.toolCount)
    expect(createHash("sha256").update(JSON.stringify(names)).digest("hex")).toBe(MCP_PARITY_CATALOG.sortedToolNamesSha256)
    const operations = new Set(REST_ROUTES.map((route) => route.operationId))
    for (const [tool, mapped] of Object.entries(MCP_REST_MAPPINGS)) {
      expect(names).toContain(tool)
      for (const operation of mapped) expect(operations).toContain(operation)
    }
  })
})
