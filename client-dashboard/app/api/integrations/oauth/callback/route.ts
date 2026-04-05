import { query } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { NextResponse } from "next/server";

// OAuth providers config
const OAUTH_PROVIDERS: Record<string, {
  tokenUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scopes: string[];
}> = {
  gmail: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  },
  microsoft_365: {
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientIdEnv: "M365_CLIENT_ID",
    clientSecretEnv: "M365_CLIENT_SECRET",
    scopes: ["Mail.ReadWrite", "Calendars.ReadWrite"],
  },
};

// GET: OAuth callback — exchanges auth code for tokens
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state"); // state = provider name
  const error = searchParams.get("error");
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  if (error) {
    return NextResponse.redirect(new URL(`/integrations?error=${error}`, request.url));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL("/integrations?error=missing_params", request.url));
  }

  const provider = OAUTH_PROVIDERS[state];
  if (!provider) {
    return NextResponse.redirect(new URL(`/integrations?error=unknown_provider`, request.url));
  }

  try {
    // Exchange auth code for tokens
    const tokenRes = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env[provider.clientIdEnv] ?? "",
        client_secret: process.env[provider.clientSecretEnv] ?? "",
        redirect_uri: `${process.env.NEXTAUTH_URL}/api/integrations/oauth/callback`,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      await query(
        `INSERT INTO integration_connections (workspace_id, provider, status, error_message)
         VALUES ($1, $2, 'error', $3)
         ON CONFLICT (workspace_id, provider) DO UPDATE SET status = 'error', error_message = $3`,
        [ws, state, tokens.error_description ?? tokens.error]
      );
      return NextResponse.redirect(new URL(`/integrations?error=${tokens.error}`, request.url));
    }

    // Store encrypted tokens
    const accessEncrypted = encrypt(tokens.access_token);
    const refreshEncrypted = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    await query(
      `INSERT INTO integration_connections
       (workspace_id, provider, status, access_token_encrypted, refresh_token_encrypted, token_expires, scopes, connected_at)
       VALUES ($1, $2, 'connected', $3, $4, $5, $6, NOW())
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         status = 'connected', access_token_encrypted = $3, refresh_token_encrypted = $4,
         token_expires = $5, scopes = $6, connected_at = NOW(), error_message = NULL`,
      [ws, state, accessEncrypted, refreshEncrypted, expiresAt, provider.scopes]
    );

    return NextResponse.redirect(new URL(`/integrations?connected=${state}`, request.url));
  } catch (e) {
    return NextResponse.redirect(new URL(`/integrations?error=${(e as Error).message}`, request.url));
  }
}
