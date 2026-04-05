import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} from "plaid";

// --- Plaid client setup ---

const env = process.env.PLAID_ENV ?? "sandbox";
const plaidEnv =
  env === "production"
    ? PlaidEnvironments.production
    : env === "development"
      ? PlaidEnvironments.development
      : PlaidEnvironments.sandbox;

const configuration = new Configuration({
  basePath: plaidEnv,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID!,
      "PLAID-SECRET": process.env.PLAID_SECRET!,
    },
  },
});

const plaid = new PlaidApi(configuration);

// --- MCP Server ---

const server = new McpServer({
  name: "plaid",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "create_link_token",
  "Create a Plaid Link token for connecting a bank account. Returns a link_token for the frontend to open Plaid Link.",
  {
    user_id: z.string().describe("Unique user identifier for this Link session"),
    products: z
      .array(z.enum(["transactions", "auth", "identity", "investments", "liabilities", "assets"]))
      .default(["transactions"])
      .describe("Plaid products to enable"),
    country_codes: z
      .array(z.enum(["US", "CA", "GB", "ES", "FR", "IE", "NL"]))
      .default(["US"])
      .describe("Country codes for supported institutions"),
    language: z.string().default("en").describe("Language for Plaid Link UI"),
  },
  async ({ user_id, products, country_codes, language }) => {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: process.env.PLAID_APP_NAME ?? "Nexaas",
      products: products as Products[],
      country_codes: country_codes as CountryCode[],
      language,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              link_token: response.data.link_token,
              expiration: response.data.expiration,
              request_id: response.data.request_id,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "exchange_public_token",
  "Exchange a public_token from Plaid Link for a persistent access_token. Call this after the user completes the Link flow.",
  {
    public_token: z.string().describe("The public_token returned by Plaid Link"),
  },
  async ({ public_token }) => {
    const response = await plaid.itemPublicTokenExchange({ public_token });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              access_token: response.data.access_token,
              item_id: response.data.item_id,
              request_id: response.data.request_id,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_accounts",
  "List all accounts associated with an access_token (checking, savings, credit, etc.)",
  {
    access_token: z.string().describe("Plaid access_token for the connected item"),
  },
  async ({ access_token }) => {
    const response = await plaid.accountsGet({ access_token });
    const accounts = response.data.accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      type: a.type,
      subtype: a.subtype,
      mask: a.mask,
      balances: {
        current: a.balances.current,
        available: a.balances.available,
        currency: a.balances.iso_currency_code,
      },
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ accounts, item_id: response.data.item.item_id }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_balances",
  "Get real-time balances for all accounts on an item",
  {
    access_token: z.string().describe("Plaid access_token"),
    account_ids: z
      .array(z.string())
      .optional()
      .describe("Optional list of account_ids to filter"),
  },
  async ({ access_token, account_ids }) => {
    const options = account_ids ? { account_ids } : undefined;
    const response = await plaid.accountsBalanceGet({ access_token, options });
    const balances = response.data.accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      current: a.balances.current,
      available: a.balances.available,
      limit: a.balances.limit,
      currency: a.balances.iso_currency_code,
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ balances }, null, 2) }],
    };
  }
);

server.tool(
  "sync_transactions",
  "Incrementally sync transactions using Plaid's transactions/sync endpoint. Pass the cursor from the previous sync to get only new changes. On first call, omit cursor to get the full history.",
  {
    access_token: z.string().describe("Plaid access_token"),
    cursor: z
      .string()
      .optional()
      .describe("Cursor from previous sync response. Omit for initial sync."),
    count: z.number().int().min(1).max(500).default(100).describe("Max transactions per page"),
  },
  async ({ access_token, cursor, count }) => {
    const response = await plaid.transactionsSync({
      access_token,
      cursor: cursor ?? "",
      count,
    });
    const { added, modified, removed, next_cursor, has_more } = response.data;

    const formatTxn = (t: any) => ({
      transaction_id: t.transaction_id,
      account_id: t.account_id,
      amount: t.amount,
      currency: t.iso_currency_code,
      date: t.date,
      name: t.name,
      merchant_name: t.merchant_name,
      category: t.personal_finance_category?.primary,
      subcategory: t.personal_finance_category?.detailed,
      pending: t.pending,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              added: added.map(formatTxn),
              modified: modified.map(formatTxn),
              removed: removed.map((r) => r.transaction_id),
              next_cursor,
              has_more,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_transactions",
  "Get transactions for a date range. Use sync_transactions for incremental updates; use this for one-off historical queries.",
  {
    access_token: z.string().describe("Plaid access_token"),
    start_date: z.string().describe("Start date (YYYY-MM-DD)"),
    end_date: z.string().describe("End date (YYYY-MM-DD)"),
    account_ids: z.array(z.string()).optional().describe("Filter to specific accounts"),
    offset: z.number().int().default(0).describe("Pagination offset"),
    count: z.number().int().min(1).max(500).default(100).describe("Max results per page"),
  },
  async ({ access_token, start_date, end_date, account_ids, offset, count }) => {
    const options: any = { count, offset };
    if (account_ids) options.account_ids = account_ids;

    const response = await plaid.transactionsGet({
      access_token,
      start_date,
      end_date,
      options,
    });

    const transactions = response.data.transactions.map((t) => ({
      transaction_id: t.transaction_id,
      account_id: t.account_id,
      amount: t.amount,
      currency: t.iso_currency_code,
      date: t.date,
      name: t.name,
      merchant_name: t.merchant_name,
      category: t.personal_finance_category?.primary,
      subcategory: t.personal_finance_category?.detailed,
      pending: t.pending,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              transactions,
              total_transactions: response.data.total_transactions,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_identity",
  "Get account holder identity information (name, email, phone, address)",
  {
    access_token: z.string().describe("Plaid access_token"),
  },
  async ({ access_token }) => {
    const response = await plaid.identityGet({ access_token });
    const accounts = response.data.accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      owners: a.owners.map((o) => ({
        names: o.names,
        emails: o.emails.map((e) => ({ data: e.data, type: e.type, primary: e.primary })),
        phones: o.phone_numbers.map((p) => ({
          data: p.data,
          type: p.type,
          primary: p.primary,
        })),
        addresses: o.addresses.map((addr) => ({
          street: addr.data.street,
          city: addr.data.city,
          region: addr.data.region,
          postal_code: addr.data.postal_code,
          country: addr.data.country,
          primary: addr.primary,
        })),
      })),
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ accounts }, null, 2) }],
    };
  }
);

server.tool(
  "get_item",
  "Get metadata about a connected Plaid Item (institution, status, error state)",
  {
    access_token: z.string().describe("Plaid access_token"),
  },
  async ({ access_token }) => {
    const response = await plaid.itemGet({ access_token });
    const item = response.data.item;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              item_id: item.item_id,
              institution_id: item.institution_id,
              products: item.products,
              consented_products: item.consented_products,
              consent_expiration_time: item.consent_expiration_time,
              update_type: item.update_type,
              error: response.data.status,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "search_institutions",
  "Search for financial institutions by name",
  {
    query: z.string().describe("Search query (e.g. 'Chase', 'Bank of America')"),
    country_codes: z
      .array(z.enum(["US", "CA", "GB", "ES", "FR", "IE", "NL"]))
      .default(["US"])
      .describe("Country codes to search within"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
  },
  async ({ query, country_codes, limit }) => {
    const response = await plaid.institutionsSearch({
      query,
      country_codes: country_codes as CountryCode[],
      products: [Products.Transactions],
      options: { include_optional_metadata: true },
    });
    const institutions = response.data.institutions.slice(0, limit).map((i) => ({
      institution_id: i.institution_id,
      name: i.name,
      url: i.url,
      logo: i.logo ? "[base64 logo available]" : null,
      products: i.products,
      country_codes: i.country_codes,
    }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ institutions }, null, 2) }],
    };
  }
);

server.tool(
  "remove_item",
  "Disconnect a Plaid Item, revoking the access_token",
  {
    access_token: z.string().describe("Plaid access_token to revoke"),
  },
  async ({ access_token }) => {
    const response = await plaid.itemRemove({ access_token });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { removed: true, request_id: response.data.request_id },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Plaid MCP server failed to start:", err);
  process.exit(1);
});
