import { NextResponse } from "next/server";

/**
 * Server-side endpoint that returns gateway configuration.
 * The API key is kept in a private env var (no NEXT_PUBLIC_ prefix)
 * so it never appears in the client-side JS bundle.
 *
 * In production, this route should be protected by session auth
 * (e.g. NextAuth.js) so only authenticated users can retrieve the key.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_DEFAULT_GATEWAY_URL || process.env.NEXT_PUBLIC_GATEWAY_URL;
  const key = process.env.DEFAULT_GATEWAY_KEY || process.env.GATEWAY_KEY;

  if (!url || !key) {
    return NextResponse.json(
      { error: "Gateway not configured" },
      { status: 503 }
    );
  }

  // TODO: In production, verify the user's session cookie here
  // before returning the gateway key.
  // e.g. const session = await getServerSession(authOptions);
  // if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    id: "default",
    name: "Default",
    url,
    apiKey: key,
  });
}
