import { ZodError } from "zod"
import { apiResourceUri, scopesSatisfy } from "@/lib/oauth/constants"
import { validateProgrammaticAuth } from "@/lib/programmatic-auth"
import { McpAuthzError, runWithMcpActor, type McpActor } from "@/lib/mcp-authz"
import { executeRestRoute, RestConflictError, RestCursorError, RestForbiddenError, RestNotFoundError, RestValidationError } from "@/lib/rest/execute"
import { matchRestRoute, type RestMethod } from "@/lib/rest/registry"
import { AnalyticsError } from "@/lib/analytics/providers"
import { DocumentError } from "@/lib/document-service"
import { CommentHttpError } from "@/lib/comment-http-error"

const NO_STORE = { "Cache-Control": "no-store" }
class RestResponseValidationError extends Error {}

export async function handleRestRequest(request: Request, method: RestMethod): Promise<Response> {
  const url = new URL(request.url)
  const auth = await validateProgrammaticAuth(request, { resource: apiResourceUri() })
  if (!auth.valid) return problem(request, 401, "invalid_token", "Unauthorized", "A valid Compass bearer token is required.", undefined, challenge(request, "api:read", "invalid_token"))
  let matched
  try {
    matched = matchRestRoute(method, url.pathname)
  } catch {
    return problem(request, 400, "malformed_path", "Bad Request", "The request path contains invalid percent encoding.")
  }
  if (!matched) return problem(request, 404, "not_found", "Not Found", "The requested resource was not found or is not accessible.")
  if (auth.scopes && !scopesSatisfy(auth.scopes, matched.route.scope)) {
    return problem(request, 403, "insufficient_scope", "Forbidden", `This operation requires ${matched.route.scope}.`, undefined, challenge(request, matched.route.scope, "insufficient_scope"))
  }
  if (auth.purpose === "RESEARCH" || auth.purpose === "AGENT_TURN") return problem(request, 403, "forbidden", "Forbidden", "This credential cannot access this resource.")

  let rawBody: unknown = undefined
  if (matched.route.bodySchema) {
    try { rawBody = await request.json() } catch { return problem(request, 400, "malformed_json", "Bad Request", "The request body must be valid JSON.") }
  }
  try {
    const params = matched.route.pathSchema.parse(matched.params) as Record<string, string>
    const queryObject = Object.fromEntries(url.searchParams)
    const query = (matched.route.querySchema?.parse(queryObject) ?? {}) as Record<string, unknown>
    const body = matched.route.bodySchema?.parse(rawBody) as Record<string, unknown> | undefined
    const actor: McpActor = { ...auth, requiredAgentAccess: matched.route.scope === "api:write" ? "WRITE" : "READ" }
    const rawResult = await runWithMcpActor(actor, () => executeRestRoute(matched.route, { params, query, body }))
    let result: unknown = undefined
    if ((matched.route.status ?? 200) !== 204) {
      const parsed = matched.route.responseSchema.safeParse(rawResult)
      if (!parsed.success) throw new RestResponseValidationError()
      result = parsed.data
    }
    if ((matched.route.status ?? 200) === 204) return new Response(null, { status: 204, headers: NO_STORE })
    const status = matched.route.status ?? 200
    const headers: Record<string, string> = { ...NO_STORE, "Content-Type": "application/json" }
    return Response.json(result, { status, headers })
  } catch (error) {
    if (error instanceof ZodError) return problem(request, 422, "validation_failed", "Unprocessable Content", "The request did not satisfy the endpoint schema.", error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })))
    if (error instanceof RestNotFoundError || error instanceof McpAuthzError) return problem(request, 404, "not_found", "Not Found", "The requested resource was not found or is not accessible.")
    if (error instanceof RestForbiddenError) return problem(request, 403, "forbidden", "Forbidden", "A human workspace member with the required role must perform this operation.")
    if (error instanceof AnalyticsError && ["NOT_FOUND_OR_ACCESS_DENIED", "ACCESS_DENIED"].includes(error.code)) return problem(request, 404, "not_found", "Not Found", "The requested resource was not found or is not accessible.")
    if (error instanceof AnalyticsError) return problem(request, 409, "conflict", "Conflict", "The analytics operation could not be completed.")
    if (error instanceof DocumentError) {
      if (["not-found", "parent-not-found", "roadmap-item-not-found"].includes(error.code)) return problem(request, 404, "not_found", "Not Found", "The requested document resource was not found or is not accessible.")
      if (["revision-conflict", "operation-conflict", "has-children"].includes(error.code)) return problem(request, 409, "conflict", "Conflict", "The document operation conflicts with the current resource state.")
      return problem(request, 422, "validation_failed", "Unprocessable Content", "The document operation did not satisfy the endpoint contract.")
    }
    if (error instanceof CommentHttpError) {
      if (error.status === 404) return problem(request, 404, "not_found", "Not Found", "The requested resource was not found or is not accessible.")
      if (error.status === 409) return problem(request, 409, "conflict", "Conflict", "The comment operation conflicts with the current thread state.")
      return problem(request, 422, "validation_failed", "Unprocessable Content", "The comment operation did not satisfy the endpoint contract.")
    }
    if (error instanceof RestCursorError) return problem(request, 400, "invalid_cursor", "Bad Request", error.message)
    if (error instanceof RestValidationError) return problem(request, 422, "validation_failed", "Unprocessable Content", error.message)
    if (error instanceof RestConflictError) return problem(request, 409, "conflict", "Conflict", error.message)
    if (error instanceof RestResponseValidationError) return problem(request, 500, "internal_error", "Internal Server Error", "The request could not be completed.")
    console.error("REST API request failed", { operationId: matched.route.operationId, error })
    return problem(request, 500, "internal_error", "Internal Server Error", "The request could not be completed.")
  }
}

function challenge(request: Request, scope: string, error?: string): Record<string, string> {
  const metadata = new URL("/.well-known/oauth-protected-resource/api/v1", request.url).toString()
  return { "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="${scope}"${error ? `, error="${error}"` : ""}` }
}

function problem(request: Request, status: number, code: string, title: string, detail: string, issues?: { path: string; message: string }[], extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ type: `https://compass.rbcodelabs.com/problems/${code}`, title, status, detail, instance: new URL(request.url).pathname, code, ...(issues ? { issues } : {}) }, { status, headers: { ...NO_STORE, "Content-Type": "application/problem+json", ...extraHeaders } })
}
