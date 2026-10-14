import { NextResponse } from "next/server"
import { z } from "zod"
import { withHomeAdmin, type HomeRouteParams } from "@/lib/portal-home/admin-api"
import { layoutSchema } from "@/lib/portal-home/schema"
import { resolveCustomerAvailability, resolveHomeForCustomer, resolveHomeForMember } from "@/lib/portal-home/resolve"

const body = z.object({
  widgets: layoutSchema,
  /** member: editor canvas (the team's internal data, plus a separate customer-availability verdict). customer: exactly what a customer would be sent. */
  audience: z.enum(["member", "customer"]),
  signedIn: z.boolean().default(false),
})

/**
 * Admin: resolve UNSAVED widgets to render data for the editor and the
 * "Preview as customer" mode. The customer audience runs the very same
 * server pipeline the public page uses.
 */
export async function POST(req: Request, route: HomeRouteParams) {
  return withHomeAdmin(route, async ({ resolveContext }) => {
    const input = body.parse(await req.json())
    if (input.audience === "member") {
      const [resolved, customerAvailability] = await Promise.all([
        resolveHomeForMember(resolveContext, input.widgets),
        resolveCustomerAvailability(resolveContext, input.widgets),
      ])
      return NextResponse.json({ resolved, customerAvailability })
    }
    const home = await resolveHomeForCustomer(resolveContext, input.widgets, { signedIn: input.signedIn })
    return NextResponse.json({ widgets: home.widgets, resolved: home.resolved })
  })
}
