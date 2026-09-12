import { NextResponse } from "next/server"
import { acknowledgePmInterviewBaseline } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError } from "@/lib/pm-interview-route"

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try {
    const context = await pmRouteContext(request)
    const { interviewId } = await params
    return NextResponse.json(await acknowledgePmInterviewBaseline(context.scope, context.actor, interviewId))
  } catch (error) { return pmRouteError(error) }
}
