import { NextResponse } from "next/server"
import { respondToPmInterview } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError, readPmRouteBody } from "@/lib/pm-interview-route"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try { const context = await pmRouteContext(request), body = await readPmRouteBody(request), { interviewId } = await params; return NextResponse.json(await respondToPmInterview(context.scope, context.actor, interviewId, body as { answer: unknown; idempotencyKey: unknown })) }
  catch (error) { return pmRouteError(error) }
}
