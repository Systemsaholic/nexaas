import { queryAll } from "@/lib/db";
import { NextResponse } from "next/server";

const AVAILABLE_PROVIDERS = [
  { id: "plaid", name: "Plaid", description: "Bank account connections", icon: "🏦", category: "financial" },
  { id: "gmail", name: "Gmail", description: "Email integration", icon: "📧", category: "email" },
  { id: "microsoft_365", name: "Microsoft 365", description: "Exchange, Teams, SharePoint", icon: "📎", category: "email" },
  { id: "stripe", name: "Stripe", description: "Payment processing", icon: "💳", category: "financial" },
  { id: "wave", name: "Wave", description: "Accounting & invoicing", icon: "📊", category: "financial" },
  { id: "quickbooks", name: "QuickBooks", description: "Accounting", icon: "📒", category: "financial" },
  { id: "slack", name: "Slack", description: "Team messaging", icon: "💬", category: "communication" },
  { id: "nextcloud", name: "Nextcloud", description: "File storage", icon: "📁", category: "storage" },
];

export async function GET() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const connections = await queryAll(
      `SELECT * FROM integration_connections WHERE workspace_id = $1`,
      [ws]
    );

    const connectionMap = new Map(connections.map((c: any) => [c.provider, c]));

    const providers = AVAILABLE_PROVIDERS.map((p) => ({
      ...p,
      connection: connectionMap.get(p.id) ?? null,
    }));

    return NextResponse.json({ ok: true, data: providers });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
