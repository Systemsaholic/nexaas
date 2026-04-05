import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
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

// POST: Create a Plaid Link token for the client to use
export async function POST() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "unknown";

  try {
    const client = getPlaidClient();

    const response = await client.linkTokenCreate({
      user: { client_user_id: ws },
      client_name: "Nexmatic",
      products: [Products.Transactions],
      country_codes: [CountryCode.Ca, CountryCode.Us],
      language: "en",
    });

    return NextResponse.json({ ok: true, data: { linkToken: response.data.link_token } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
