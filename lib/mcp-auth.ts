// MCP_API_KEY must be set in your environment / Vercel project settings.
// Any request to the MCP route must carry:  Authorization: Bearer <MCP_API_KEY>
export function validateMcpAuth(request: Request): boolean {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return false
  const token = authHeader.slice(7)
  return token === process.env.MCP_API_KEY
}
