import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
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
