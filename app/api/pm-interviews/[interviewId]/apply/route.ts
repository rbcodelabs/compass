import { NextResponse } from "next/server"
import { applyPmInterview } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError, readPmRouteBody } from "@/lib/pm-interview-route"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try {
    const context = await pmRouteContext(request), body = await readPmRouteBody(request), { interviewId } = await params
    const injectFailure = process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1" && process.env.E2E_ISOLATED_DATABASE === "1" && request.headers.get("x-e2e-pm-fail-receipt-finalization") === "1"
    return NextResponse.json(await applyPmInterview(context.scope, context.actor, interviewId, body as { selectedFields: string[]; editedValues?: Record<string, string | null>; idempotencyKey: unknown }, injectFailure ? { failReceiptFinalization: true } : undefined))
  }
  catch (error) { return pmRouteError(error) }
}
