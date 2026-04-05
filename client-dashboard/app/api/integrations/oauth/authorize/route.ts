import { NextResponse } from "next/server";

const OAUTH_CONFIGS: Record<string, {
  authUrl: string;
  clientIdEnv: string;
  scopes: string;
}> = {
  gmail: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    scopes: "https://www.googleapis.com/auth/gmail.modify",
  },
  microsoft_365: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    clientIdEnv: "M365_CLIENT_ID",
    scopes: "Mail.ReadWrite Calendars.ReadWrite offline_access",
  },
};

// GET: Redirect to OAuth provider's authorization page
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");

  if (!provider || !OAUTH_CONFIGS[provider]) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const config = OAUTH_CONFIGS[provider];
  const clientId = process.env[config.clientIdEnv];

  if (!clientId) {
    return NextResponse.json({ error: `${provider} not configured (missing ${config.clientIdEnv})` }, { status: 500 });
  }

  const redirectUri = `${process.env.NEXTAUTH_URL}/api/integrations/oauth/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes,
    state: provider,
    access_type: "offline",
    prompt: "consent",
  });

  return NextResponse.redirect(`${config.authUrl}?${params.toString()}`);
}
