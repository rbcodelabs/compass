import { NextResponse } from "next/server"
import { completePmInterview } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError } from "@/lib/pm-interview-route"

// Covers the 150s generation budget plus sandbox cleanup and database receipts.
export const maxDuration = 180

export async function POST(request: Request, { params }: { params: Promise<{ interviewId: string }> }) {
  try { const context = await pmRouteContext(request), { interviewId } = await params; return NextResponse.json(await completePmInterview(context.scope, context.actor, interviewId)) }
  catch (error) { return pmRouteError(error) }
}
