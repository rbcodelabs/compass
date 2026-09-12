import { NextResponse } from "next/server"
import { readPmInterview } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError } from "@/lib/pm-interview-route"

export async function GET(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try {
    const context = await pmRouteContext(request), { interviewId } = await params
    return NextResponse.json(await readPmInterview(context.scope, context.actor, interviewId))
  } catch (error) { return pmRouteError(error) }
}
