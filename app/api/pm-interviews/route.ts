import { NextResponse } from "next/server"
import { createPmInterview } from "@/lib/pm-interview-service"
import { pmRouteContext, pmRouteError, readPmRouteBody } from "@/lib/pm-interview-route"

export async function POST(request: Request) {
  try {
    const context = await pmRouteContext(request), body = await readPmRouteBody(request)
    if (typeof body.targetId !== "string") return NextResponse.json({ error: "Invalid target" }, { status: 400 })
    return NextResponse.json(await createPmInterview(context.scope, context.actor, { targetType: body.targetType, targetId: body.targetId }), { status: 201 })
  } catch (error) { return pmRouteError(error) }
}
