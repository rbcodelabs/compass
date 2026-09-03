import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";
import { NextResponse } from "next/server";
import {
  createPreviewPerformanceCorrelation,
  PERFORMANCE_INVOCATION_HEADER,
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
  );
  if (correlation) {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set(PERFORMANCE_INVOCATION_HEADER, correlation.invocationId);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set(correlation.header, correlation.invocationId);
    return response;
  }
})


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
