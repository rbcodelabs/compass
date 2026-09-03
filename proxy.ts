import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";
import { NextResponse } from "next/server";
import {
  createPreviewPerformanceCorrelation,
  createServerOwnedPerformanceHeaders,
  PERFORMANCE_BUILD_SHA_HEADER,
  PERFORMANCE_SAMPLE_HEADER,
} from "@/lib/performance-request-correlation";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
export const proxy = auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname } = req.nextUrl

  if (!isLoggedIn && !isPublicPath(pathname)) {
    return Response.redirect(new URL("/login", req.nextUrl))
  }

  const correlation = createPreviewPerformanceCorrelation(
    process.env,
    req.headers.get(PERFORMANCE_SAMPLE_HEADER),
    req.headers.get(PERFORMANCE_BUILD_SHA_HEADER),
  );
  const requestHeaders = createServerOwnedPerformanceHeaders(req.headers, correlation);
  if (correlation) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set(correlation.header, correlation.invocationId);
    return response;
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
})


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
