import { NextRequest } from "next/server";

/**
 * Server-side SSE proxy for engine events.
 * Forwards the engine's /api/events SSE stream to the client,
 * keeping the API key server-side.
 */
export async function GET(req: NextRequest) {
  const engineUrl = process.env.ENGINE_INTERNAL_URL || process.env.NEXT_PUBLIC_DEFAULT_GATEWAY_URL;
  const engineKey = process.env.DEFAULT_GATEWAY_KEY;

  if (!engineUrl || !engineKey) {
    return new Response("Gateway not configured", { status: 503 });
  }

  // TODO: Verify user session here before proxying
  // const session = await getServerSession(authOptions);
  // if (!session) return new Response("Unauthorized", { status: 401 });

  const targetUrl = `${engineUrl}/api/events`;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${engineKey}`,
        Accept: "text/event-stream",
      },
    });

    if (!res.ok) {
      return new Response(`Engine returned ${res.status}`, { status: res.status });
    }

    // Forward the SSE stream
    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("Gateway SSE proxy error:", err);
    return new Response("Gateway connection failed", { status: 502 });
  }
}
