import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import openapiTS, { astToString } from "openapi-typescript"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { TOOL_SCOPES } from "@/lib/mcp-tool-gates"
import { buildOpenApiDocument } from "@/lib/rest/openapi"
import * as parityManifest from "@/lib/rest/parity-manifest"
import { REST_ROUTES } from "@/lib/rest/registry"

type ParityDisposition =
  | { kind: "direct"; operationId: string }
  | { kind: "composition"; operationIds: readonly string[]; documentationAnchor: string; rationale: string }
  | { kind: "excluded"; category: string; documentationAnchor: string; restAlternative: string; rationale: string }

type CompleteParityManifest = Record<string, ParityDisposition>

const { MCP_PARITY_CATALOG } = parityManifest

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

  it("generates and strictly compiles representative typed client contracts", async () => {
    const document = buildOpenApiDocument()
    const generated = astToString(await openapiTS(Buffer.from(JSON.stringify(document))))
    const source = `${generated}
      type Identity = operations["getCurrentIdentity"]["responses"][200]["content"]["application/json"]
      type CreateOpportunityInput = operations["createOpportunity"]["requestBody"]["content"]["application/json"]
      type CreateOpportunityResponse = operations["createOpportunity"]["responses"][201]["content"]["application/json"]
      type ListOpportunitiesParameters = operations["listOpportunities"]["parameters"]
      type ListOpportunitiesResponse = operations["listOpportunities"]["responses"][200]["content"]["application/json"]
      type ValidationProblem = operations["createOpportunity"]["responses"][422]["content"]["application/problem+json"]

      const identity: Identity = { purpose: "USER", userId: "user-id", agentId: null, workspaces: [{ id: "workspace-id", name: "Discovery", slug: "discovery" }] }
      const createInput: CreateOpportunityInput = { title: "Customer need", status: "EXPLORING" }
      const created: CreateOpportunityResponse = {
        id: "opportunity-id", createdAt: "2026-10-02T12:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z",
        workspaceId: "workspace-id", title: createInput.title, description: null, customerSegment: null,
        status: "EXPLORING", squadId: null, linkedKeyResultId: null,
      }
      const listParameters: ListOpportunitiesParameters = { path: { workspaceId: "workspace-id" }, query: { cursor: "cursor", limit: 25, status: "ACTIVE" } }
      const page: ListOpportunitiesResponse = { items: [created], nextCursor: "next-cursor" }
      const validation: ValidationProblem = {
        type: "about:blank", title: "Validation failed", status: 422, detail: "Request validation failed",
        instance: "/api/v1/workspaces/workspace-id/opportunities", code: "VALIDATION_FAILED",
        issues: [{ path: "title", message: "Required" }],
      }

      // @ts-expect-error create title is required
      const missingTitle: CreateOpportunityInput = {}
      // @ts-expect-error archived is not a valid create status
      const invalidStatus: CreateOpportunityInput = { title: "Customer need", status: "ARCHIVED" }
      // @ts-expect-error pagination limit is numeric
      const invalidPagination: ListOpportunitiesParameters = { path: { workspaceId: "workspace-id" }, query: { limit: "25" } }
      // @ts-expect-error RFC 9457 extension code is required by this API
      const malformedProblem: ValidationProblem = { type: "about:blank", title: "Invalid", status: 422, detail: "Invalid", instance: "/api/v1" }

      void [identity, listParameters, page, validation, missingTitle, invalidStatus, invalidPagination, malformedProblem]
    `
    const directory = await mkdtemp(join(tmpdir(), "compass-openapi-client-"))
    const file = join(directory, "generated-client.ts")
    try {
      await writeFile(file, source)
      const program = ts.createProgram([file], {
        strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      })
      const errors = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
      expect(errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("fails when the MCP catalog changes without a parity-ledger revision", () => {
    const names = Object.keys(TOOL_SCOPES).sort()
    expect(names).toHaveLength(MCP_PARITY_CATALOG.toolCount)
    expect(createHash("sha256").update(JSON.stringify(names)).digest("hex")).toBe(MCP_PARITY_CATALOG.sortedToolNamesSha256)
  })

  it("gives every MCP capability one final REST disposition", () => {
    const manifest = (parityManifest as typeof parityManifest & {
      MCP_REST_PARITY_MANIFEST?: CompleteParityManifest
    }).MCP_REST_PARITY_MANIFEST
    expect(manifest, "Phase 5 must replace the provisional parity ledger").toBeDefined()

    const toolNames = Object.keys(TOOL_SCOPES).sort()
    expect(Object.keys(manifest ?? {}).sort()).toEqual(toolNames)

    const operationIds = new Set(REST_ROUTES.map((route) => route.operationId))
    const routesByOperation = new Map(REST_ROUTES.map((route) => [route.operationId, route]))
    for (const [toolName, disposition] of Object.entries(manifest ?? {})) {
      expect(toolNames, `${toolName} is not an MCP capability`).toContain(toolName)
      if (disposition.kind === "direct") {
        expect(operationIds, `${toolName} maps to an unknown REST operation`).toContain(disposition.operationId)
        expect(routesByOperation.get(disposition.operationId)?.scope).toBe(TOOL_SCOPES[toolName] === "mcp:read" ? "api:read" : "api:write")
        continue
      }

      expect(disposition.documentationAnchor, `${toolName} must have a documentation anchor`).toMatch(/^docs\/[^#]+#[a-z0-9-]+$/)
      const [documentationPath, anchor] = disposition.documentationAnchor.split("#")
      expect(existsSync(documentationPath), `${toolName} documentation file does not exist`).toBe(true)
      const documentedAnchors = [...readFileSync(documentationPath, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)]
        .map(([, heading]) => heading.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-"))
      expect(documentedAnchors, `${toolName} documentation anchor does not exist`).toContain(anchor)
      expect(disposition.rationale.trim(), `${toolName} needs a specific rationale`).not.toBe("")
      if (disposition.kind === "composition") {
        expect(disposition.operationIds.length, `${toolName} composition cannot be empty`).toBeGreaterThan(0)
        expect(new Set(disposition.operationIds).size, `${toolName} composition cannot repeat operations`).toBe(disposition.operationIds.length)
        for (const operationId of disposition.operationIds) {
          expect(operationIds, `${toolName} composition references an unknown REST operation`).toContain(operationId)
        }
        const scopes = disposition.operationIds.map((operationId) => routesByOperation.get(operationId)?.scope)
        if (TOOL_SCOPES[toolName] === "mcp:read") expect(new Set(scopes)).toEqual(new Set(["api:read"]))
        else expect(scopes).toContain("api:write")
      } else {
        expect(disposition.category.trim(), `${toolName} needs an exclusion category`).not.toBe("")
        expect(disposition.restAlternative.trim(), `${toolName} needs a REST alternative`).not.toBe("")
      }
    }
  })
})
