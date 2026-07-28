import { auth } from "@/auth";
import { isPublicPath } from "@/lib/route-access";

// Next.js 16: proxy.ts runs in Node.js (not Edge), so we can use the full
// auth export (with PrismaAdapter). No need for the stripped-down authConfig.
export const proxy = auth((req) => {
  const isLoggedIn = !!req.auth
  const { pathname } = req.nextUrl

  if (!isLoggedIn && !isPublicPath(pathname)) {
    return Response.redirect(new URL("/login", req.nextUrl))
  }
})


export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
