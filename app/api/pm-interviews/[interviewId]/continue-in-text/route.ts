import { NextResponse } from "next/server"
import { switchPmInterviewToText } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError, readPmRouteBody } from "@/lib/pm-interview-route"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try { const context = await pmRouteContext(request), body = await readPmRouteBody(request), { interviewId } = await params; if (Object.keys(body).some(key => !["leaseId", "settlement"].includes(key))) return NextResponse.json({ error: "Invalid request" }, { status: 400 }); return NextResponse.json(await switchPmInterviewToText(context.scope, context.actor, interviewId, { leaseId: body.leaseId ?? null, settlement: body.settlement })) }
  catch (error) { return pmRouteError(error) }
}
