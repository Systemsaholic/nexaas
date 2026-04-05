import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { query } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { NextResponse } from "next/server";

function getPlaidClient() {
  const config = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV as keyof typeof PlaidEnvironments ?? "sandbox"],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID ?? "",
        "PLAID-SECRET": process.env.PLAID_SECRET ?? "",
      },
    },
  });
  return new PlaidApi(config);
}

// POST: Exchange public token for access token after Plaid Link completes
export async function POST(request: Request) {
  const { publicToken, institutionName, accounts } = await request.json();
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  if (!publicToken) {
    return NextResponse.json({ error: "publicToken required" }, { status: 400 });
  }

  try {
    const client = getPlaidClient();
    const response = await client.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Store encrypted access token
    const encrypted = encrypt(accessToken);

    await query(
      `INSERT INTO integration_connections
       (workspace_id, provider, status, access_token_encrypted, scopes, metadata, connected_at)
       VALUES ($1, 'plaid', 'connected', $2, $3, $4, NOW())
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         status = 'connected', access_token_encrypted = $2, scopes = $3,
         metadata = $4, connected_at = NOW(), error_message = NULL`,
      [
        ws,
        encrypted,
        ["transactions", "accounts", "balances"],
        JSON.stringify({ item_id: itemId, institution: institutionName, accounts: accounts ?? [] }),
      ]
    );

    return NextResponse.json({ ok: true, message: "Bank account connected via Plaid" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
