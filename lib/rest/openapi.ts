import { z } from "zod"
import { REST_ROUTES } from "@/lib/rest/registry"
import { problemSchema } from "@/lib/rest/schemas"

type OpenApiOperation = { operationId: string; [key: string]: unknown }
type OpenApiDocument = {
  openapi: string
  info: { title: string; version: string; description: string }
  servers: { url: string }[]
  paths: Record<string, Record<string, OpenApiOperation>>
  components: Record<string, unknown>
}

const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: "draft-2020-12", unrepresentable: "any" })

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {}
  for (const route of REST_ROUTES) {
    const pathJson = schema(route.pathSchema) as { properties?: Record<string, Record<string, unknown>> }
    const parameters = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1], in: "path", required: true,
      schema: pathJson.properties?.[match[1]] ?? { type: "string" },
    }))
    const operation: OpenApiOperation = {
      operationId: route.operationId,
      summary: route.summary,
      security: [{ bearerAuth: [route.scope] }],
      parameters,
      ...(route.querySchema ? { parameters: [...parameters, ...queryParameters(route.querySchema)] } : {}),
      ...(route.bodySchema ? { requestBody: { required: true, content: { "application/json": { schema: schema(route.bodySchema) } } } } : {}),
      responses: {
        [String(route.status ?? 200)]: route.status === 204
          ? { description: "No content" }
          : { description: "Success", content: { "application/json": { schema: schema(route.responseSchema) } } },
        "400": problemResponse(), "401": problemResponse(), "403": problemResponse(),
        "404": problemResponse(), "409": problemResponse(), "422": problemResponse(), "500": problemResponse(),
      },
    }
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method.toLowerCase()]: operation }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Compass REST API", version: "1.0.0", description: "Resource-oriented API for Compass product discovery and delivery data." },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "/oauth/authorize",
              tokenUrl: "/api/oauth/token",
              scopes: { "api:read": "Read Compass resources", "api:write": "Create and change Compass resources" },
            },
          },
        },
      },
      schemas: { Problem: schema(problemSchema) },
    },
  }
}

function queryParameters(querySchema: z.ZodType): Record<string, unknown>[] {
  const json = schema(querySchema) as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({ name, in: "query", required: json.required?.includes(name) ?? false, schema: property }))
}

function problemResponse() {
  return { description: "Problem Details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } }
}
