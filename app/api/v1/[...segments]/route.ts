import { handleRestRequest } from "@/lib/rest/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export const GET = (request: Request) => handleRestRequest(request, "GET")
export const POST = (request: Request) => handleRestRequest(request, "POST")
export const PATCH = (request: Request) => handleRestRequest(request, "PATCH")
export const DELETE = (request: Request) => handleRestRequest(request, "DELETE")
