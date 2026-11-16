/**
 * Liveness probe for a load balancer or container orchestrator target.
 *
 * Deliberately does nothing but answer: no database, no session, no secrets, no
 * environment lookup. A probe that touches the database would take every
 * instance out of rotation during a database blip, and the restart that follows
 * cannot fix the database. It says only that this process is up and serving HTTP.
 *
 * Public in lib/route-access.ts as an exact path.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "cache-control": "no-store" }

export function GET() {
  return Response.json({ status: "ok" }, { headers })
}

// Probes use GET; HEAD is what `curl -I` and some probes send.
export function HEAD() {
  return new Response(null, { status: 200, headers })
}
