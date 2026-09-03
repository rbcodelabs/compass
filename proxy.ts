import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import {
  createPreviewPerformanceCorrelation,
  createServerOwnedPerformanceHeaders,
  PERFORMANCE_BUILD_SHA_HEADER,
  PERFORMANCE_SAMPLE_HEADER,
  runWithPerformanceInvocation,
} from "@/lib/performance-request-correlation";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
const authenticatedProxy = auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname } = req.nextUrl

  if (!isLoggedIn && !isPublicPath(pathname)) {
    return Response.redirect(new URL("/login", req.nextUrl))
  }

  return NextResponse.next({ request: { headers: req.headers } });
})

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const correlation = createPreviewPerformanceCorrelation(
    process.env, req.headers.get(PERFORMANCE_SAMPLE_HEADER), req.headers.get(PERFORMANCE_BUILD_SHA_HEADER),
    req.method, req.nextUrl.pathname,
  );
  const headers = createServerOwnedPerformanceHeaders(req.headers, correlation);
  const sanitized = new NextRequest(req, { headers });
  return runWithPerformanceInvocation(correlation?.invocationId ?? null, async () => {
    const response = await (authenticatedProxy as unknown as (
      request: NextRequest, event: NextFetchEvent,
    ) => Promise<NextResponse | Response | void>)(sanitized, event);
    const resolved = response ?? NextResponse.next({ request: { headers } });
    if (correlation) resolved.headers.set(correlation.header, correlation.invocationId);
    return resolved;
  });
}


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
