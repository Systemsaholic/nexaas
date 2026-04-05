import { queryAll } from "@/lib/db";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

// Friendly names for MCP servers
const MCP_META: Record<string, { name: string; description: string; icon: string; category: string }> = {
  filesystem: { name: "File Storage", description: "Read and manage workspace files", icon: "📁", category: "system" },
  email: { name: "Email", description: "Send and receive emails", icon: "📧", category: "communication" },
  m365: { name: "Microsoft 365", description: "Exchange, Teams, SharePoint", icon: "📎", category: "communication" },
  github: { name: "GitHub", description: "Code repositories and issues", icon: "💻", category: "development" },
  postgres: { name: "Database", description: "Query and manage data", icon: "🗄️", category: "system" },
  playwright: { name: "Browser Automation", description: "Web scraping and testing", icon: "🌐", category: "automation" },
  "brave-search": { name: "Web Search", description: "Search the web", icon: "🔍", category: "information" },
  slack: { name: "Slack", description: "Team messaging", icon: "💬", category: "communication" },
  nextcloud: { name: "Nextcloud", description: "File storage and calendar", icon: "☁️", category: "storage" },
  telegram: { name: "Telegram", description: "Notifications", icon: "✈️", category: "communication" },
  groundhogg: { name: "CRM", description: "Contacts and campaigns", icon: "🐿️", category: "business" },
  plaid: { name: "Bank Connections", description: "Connect bank accounts", icon: "🏦", category: "financial" },
  quickbooks: { name: "QuickBooks", description: "Accounting", icon: "📒", category: "financial" },
  stripe: { name: "Payments", description: "Payment processing", icon: "💳", category: "financial" },
  wave: { name: "Wave", description: "Invoicing", icon: "📊", category: "financial" },
  docuseal: { name: "Document Signing", description: "Digital signatures", icon: "📝", category: "documents" },
};

export async function GET() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    // Read workspace manifest for deployed MCP servers
    const manifestPath = join(NEXAAS_ROOT, "workspaces", `${ws}.workspace.json`);
    let manifestMcp: Record<string, string> = {};
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifestMcp = JSON.parse(raw).mcp ?? {};
    } catch { /* no manifest */ }

    // Collect MCP servers required by deployed skills
    const skills = await queryAll<{ skill_id: string }>(
      `SELECT skill_id FROM workspace_skills WHERE workspace_id = $1`,
      [ws]
    );

    const skillMcpServers = new Set<string>();
    for (const s of skills) {
      const [category, name] = s.skill_id.split("/");
      try {
        const yaml = await import("js-yaml");
        const contractRaw = await readFile(join(NEXAAS_ROOT, "skills", category, name, "contract.yaml"), "utf-8");
        const contract = yaml.load(contractRaw) as { mcp_servers?: string[] };
        for (const mcp of contract.mcp_servers ?? []) skillMcpServers.add(mcp);
      } catch { /* skip */ }
    }

    // Merge manifest + skill-required MCP servers
    const allMcpIds = new Set([...Object.keys(manifestMcp), ...skillMcpServers]);

    // Connection status from DB
    const connections = await queryAll(`SELECT * FROM integration_connections WHERE workspace_id = $1`, [ws]);
    const connectionMap = new Map(connections.map((c: any) => [c.provider, c]));

    const providers = Array.from(allMcpIds).map((mcpId) => {
      const meta = MCP_META[mcpId] ?? {
        name: mcpId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: `${mcpId} integration`,
        icon: "🔌",
        category: "other",
      };

      return {
        id: mcpId,
        ...meta,
        requiredBySkills: skillMcpServers.has(mcpId),
        connection: connectionMap.get(mcpId) ?? null,
      };
    });

    return NextResponse.json({ ok: true, data: providers });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
