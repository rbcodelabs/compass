import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import openapiTS, { astToString } from "openapi-typescript"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { buildOpenApiDocument } from "@/lib/rest/openapi"

const fixtureDirectory = join(process.cwd(), "__tests__/fixtures/rest-generated-client")
const expectedHashPath = join(fixtureDirectory, "schema.sha256")
const consumerFixturePath = join(fixtureDirectory, "consumer.ts.fixture")

async function generateClientTypes(): Promise<string> {
  const ast = await openapiTS(JSON.stringify(buildOpenApiDocument()), {
    alphabetize: true,
    silent: true,
  })
  return astToString(ast)
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
    if (!diagnostic.file || diagnostic.start === undefined) return message
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`
  }).join("\n")
}

describe("generated REST client", () => {
  it("has unique operation IDs and deterministic generated output", async () => {
    const document = buildOpenApiDocument()
    const operationIds = Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem).map((operation) => operation.operationId),
    )
    expect(new Set(operationIds).size).toBe(operationIds.length)
    const createOpportunityResponses = document.paths["/api/v1/workspaces/{workspaceId}/opportunities"]?.post["responses"]
    const listOpportunityResponses = document.paths["/api/v1/workspaces/{workspaceId}/opportunities"]?.get["responses"]
    const deleteAssumptionResponses = document.paths["/api/v1/workspaces/{workspaceId}/assumptions/{id}"]?.delete["responses"]
    expect(createOpportunityResponses).toHaveProperty("201")
    expect(deleteAssumptionResponses).toHaveProperty("204")
    expect(listOpportunityResponses).toHaveProperty(
      "422.content.application/problem+json.schema.$ref",
      "#/components/schemas/Problem",
    )

    const first = await generateClientTypes()
    const second = await generateClientTypes()
    expect(second).toBe(first)

    const actualHash = createHash("sha256").update(first).digest("hex")
    expect(actualHash).toBe(readFileSync(expectedHashPath, "utf8").trim())
  })

  it("semantically compiles a real openapi-fetch consumer fixture", async () => {
    const temporaryDirectory = mkdtempSync(join(process.cwd(), ".rest-client-"))
    const generatedPath = join(temporaryDirectory, "rest-openapi.generated.ts")
    const consumerPath = join(temporaryDirectory, "consumer.ts")

    try {
      writeFileSync(generatedPath, await generateClientTypes())
      writeFileSync(consumerPath, readFileSync(consumerFixturePath, "utf8"))

      const program = ts.createProgram({
        rootNames: [generatedPath, consumerPath],
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
        },
      })
      const diagnostics = ts.getPreEmitDiagnostics(program)
      expect(formatDiagnostics(diagnostics)).toBe("")
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
