/**
 * Nexaas Email-Outbound MCP Server (#78 PR A).
 *
 * Implements the `email-outbound` capability defined in
 * capabilities/_registry.yaml. Skills declaring `mcp_servers: [email-outbound]`
 * receive `send` and `track` tools for transactional and marketing email.
 *
 * Provider-pluggable. PR A ships with Resend; Postmark, SendGrid, AWS SES
 * follow in a separate PR (issue #78 step 2). All providers conform to the
 * EmailProvider interface in `types.ts`, so the MCP entry point stays
 * provider-agnostic — selection happens once at server start (see
 * `provider-select.ts`) and is logged on stderr.
 *
 * Transport: stdio. Wire into a workspace's `.mcp.json` and reference by
 * name from a skill manifest's `mcp_servers` array.
 *
 * Environment:
 *   RESEND_API_KEY                 — Resend bearer token (PR A)
 *   EMAIL_OUTBOUND_PROVIDER        — pin a specific provider (optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { selectProvider } from "./provider-select.js";

const selected = selectProvider();
console.error(`[email-outbound] provider=${selected.name} (${selected.reason})`);

const server = new McpServer({
  name: "nexaas-email-outbound",
  version: "0.1.0",
});

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const sendSchema = {
  from: z.object({
    email: z.string().email(),
    name: z.string().optional(),
  }).describe("Sender address. `name` becomes the display-name in the From header."),
  reply_to: z.string().email().optional().describe("Sets the Reply-To header. Optional."),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1)])
    .describe("One recipient or many. Provider splits into separate sends if needed."),
  subject: z.string().min(1).describe("Subject line."),
  body_text: z.string().min(1).describe(
    "Plain-text body. Required for deliverability — providers reject html-only sends.",
  ),
  body_html: z.string().optional().describe("Optional HTML body."),
  headers: z.record(z.string()).optional().describe(
    "Custom headers (e.g., List-Unsubscribe). Provider may reject reserved ones.",
  ),
  tracking: z.object({
    opens: z.boolean().optional(),
    clicks: z.boolean().optional(),
  }).optional().describe(
    "Provider-side tracking flags. Some providers configure this at the domain/key level " +
    "(Resend) and ignore per-message toggles — see provider docs.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Provider-side analytics labels (Resend tags, SendGrid categories, etc.).",
  ),
  attachments: z.array(z.object({
    filename: z.string(),
    content_base64: z.string(),
  })).optional(),
};

server.tool(
  "send",
  "Send a transactional or marketing email through the workspace's configured provider. " +
  "Returns `message_id` (omitted when *all* recipients were rejected — guard before passing to `track`), " +
  "`accepted` (recipients the provider took), and `rejected` (per-recipient failures with reason).",
  sendSchema,
  async (input) => {
    try {
      const result = await selected.provider.send(input);
      return jsonResult({ ok: true, provider: selected.name, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ ok: false, provider: selected.name, error: message });
    }
  },
);

server.tool(
  "track",
  "Fetch delivery / engagement state for a previously-sent message. Open and click counts " +
  "are eventually-consistent (webhook-driven on most providers); absent fields mean " +
  "'not yet known', not 'did not happen'.",
  {
    message_id: z.string().min(1).describe("From a prior send response."),
  },
  async (input) => {
    try {
      const result = await selected.provider.track(input.message_id);
      return jsonResult({ ok: true, provider: selected.name, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ ok: false, provider: selected.name, error: message });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
