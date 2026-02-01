import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy for engine API calls.
 * The client sends requests here; this route adds the API key and
 * forwards to the actual engine, keeping the key server-side.
 *
 * Usage: POST /api/engine/proxy
 * Body: { path: "/workspace", method?: "GET", body?: {...} }
 */
export async function POST(req: NextRequest) {
  const engineUrl = process.env.ENGINE_INTERNAL_URL || process.env.NEXT_PUBLIC_DEFAULT_GATEWAY_URL;
  const engineKey = process.env.DEFAULT_GATEWAY_KEY;

  if (!engineUrl || !engineKey) {
    return NextResponse.json(
      { error: "Gateway not configured" },
      { status: 503 }
    );
  }

  // TODO: Verify user session here before proxying
  // const session = await getServerSession(authOptions);
  // if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: { path: string; method?: string; body?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { path, method = "GET", body } = payload;

  // Validate path to prevent SSRF — must start with /
  if (!path || typeof path !== "string" || !path.startsWith("/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Block attempts to access internal/admin paths
  const blockedPaths = ["/admin", "/internal", "/../"];
  if (blockedPaths.some((bp) => path.toLowerCase().includes(bp))) {
    return NextResponse.json({ error: "Forbidden path" }, { status: 403 });
  }

  const targetUrl = `${engineUrl}/api${path}`;

  try {
    const res = await fetch(targetUrl, {
      method,
      headers: {
        Authorization: `Bearer ${engineKey}`,
        "Content-Type": "application/json",
      },
      ...(body && method !== "GET" ? { body: JSON.stringify(body) } : {}),
    });

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      return NextResponse.json(data, { status: res.status });
    }

    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "Content-Type": contentType },
    });
  } catch (err) {
    console.error("Gateway proxy error:", err);
    return NextResponse.json(
      { error: "Gateway connection failed" },
      { status: 502 }
    );
  }
}
