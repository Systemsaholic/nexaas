import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

const ENGINE_URL = process.env.NEXT_PUBLIC_DEFAULT_GATEWAY_URL || "http://localhost:8400";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ action: string[] }> }
) {
  const { action } = await params;
  const actionPath = action.join("/");

  if (actionPath !== "me") {
    return NextResponse.json({ detail: "Not found" }, { status: 404 });
  }

  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    return NextResponse.json({ detail: "Not authenticated" }, { status: 401 });
  }

  try {
    const res = await fetch(`${ENGINE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ detail: "Engine connection failed" }, { status: 502 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ action: string[] }> }
) {
  const { action } = await params;
  const actionPath = action.join("/");

  // Only allow known auth actions
  if (!["register", "login", "logout"].includes(actionPath)) {
    return NextResponse.json({ detail: "Not found" }, { status: 404 });
  }

  // Logout — just clear the cookie
  if (actionPath === "logout") {
    const jar = await cookies();
    jar.delete("auth_token");
    return NextResponse.json({ ok: true });
  }

  // Forward register/login to engine
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ detail: "Invalid body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${ENGINE_URL}/api/auth/${actionPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    // Set httpOnly cookie with the JWT
    if (data.token) {
      const jar = await cookies();
      jar.set("auth_token", data.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7, // 7 days
      });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("Auth proxy error:", err);
    return NextResponse.json({ detail: "Engine connection failed" }, { status: 502 });
  }
}
