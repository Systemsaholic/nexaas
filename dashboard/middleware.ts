import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CORS preflight for API routes
  if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  // API routes: check bearer token or cookie
  if (pathname.startsWith("/api/v1/")) {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) return unauthorized();

    const authHeader = request.headers.get("authorization");
    const cookieToken = request.cookies.get("nexaas_admin")?.value;

    if (authHeader?.startsWith("Bearer ") && authHeader.slice(7) === secret) {
      return withCors(NextResponse.next());
    }
    if (cookieToken === secret) {
      return withCors(NextResponse.next());
    }
    return unauthorized();
  }

  // Admin pages: check cookie, redirect to login if missing
  if (pathname.startsWith("/admin")) {
    const secret = process.env.ADMIN_SECRET;
    const cookieToken = request.cookies.get("nexaas_admin")?.value;

    if (!secret || cookieToken !== secret) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  return NextResponse.next();
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": CORS_ORIGIN || "null",  // Deny cross-origin by default — set CORS_ORIGIN for external access
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(response: NextResponse): NextResponse {
  const headers = corsHeaders();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

export const config = {
  matcher: ["/admin/:path*", "/api/v1/:path*"],
};
