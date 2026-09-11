import { NextResponse } from "next/server"
import { switchPmInterviewToText } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError, readPmRouteBody } from "@/lib/pm-interview-route"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try { const context = await pmRouteContext(request), body = await readPmRouteBody(request), { interviewId } = await params; return NextResponse.json(await switchPmInterviewToText(context.scope, context.actor, interviewId, body.discardPending === true, typeof body.retiredLeaseId === "string" ? body.retiredLeaseId : undefined)) }
  catch (error) { return pmRouteError(error) }
}
