import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public paths — no auth required
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/invite") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Admin backdoor — ops can access with ADMIN_SECRET
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret) {
    const authHeader = request.headers.get("authorization");
    const adminCookie = request.cookies.get("nexaas_admin")?.value;

    if (
      (authHeader?.startsWith("Bearer ") && authHeader.slice(7) === adminSecret) ||
      adminCookie === adminSecret
    ) {
      // Admin access — add header so pages can show admin banner
      const response = NextResponse.next();
      response.headers.set("x-admin-session", "true");
      return response;
    }
  }

  // Check Auth.js session token
  const sessionToken = request.cookies.get("authjs.session-token")?.value
    || request.cookies.get("__Secure-authjs.session-token")?.value;

  if (!sessionToken) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
