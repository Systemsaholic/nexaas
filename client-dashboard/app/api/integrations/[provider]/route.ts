import { query, queryOne } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { NextResponse } from "next/server";

const ws = () => process.env.NEXAAS_WORKSPACE ?? "";

// POST: Connect an integration (API key based — not OAuth)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { apiKey, scopes, metadata } = await request.json();

  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  try {
    const encrypted = encrypt(apiKey);

    await query(
      `INSERT INTO integration_connections (workspace_id, provider, status, access_token_encrypted, scopes, metadata, connected_at)
       VALUES ($1, $2, 'connected', $3, $4, $5, NOW())
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         status = 'connected', access_token_encrypted = $3, scopes = $4,
         metadata = $5, connected_at = NOW(), error_message = NULL`,
      [ws(), provider, encrypted, scopes ?? [], metadata ? JSON.stringify(metadata) : "{}"]
    );

    return NextResponse.json({ ok: true, message: `${provider} connected` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// DELETE: Disconnect an integration
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  try {
    await query(
      `UPDATE integration_connections SET status = 'revoked', access_token_encrypted = NULL, refresh_token_encrypted = NULL
       WHERE workspace_id = $1 AND provider = $2`,
      [ws(), provider]
    );
    return NextResponse.json({ ok: true, message: `${provider} disconnected` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
