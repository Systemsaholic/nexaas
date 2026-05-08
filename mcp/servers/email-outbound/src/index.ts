/**
 * Nexaas Email-Outbound MCP Server (#78).
 *
 * Implements the `email-outbound` capability defined in
 * capabilities/_registry.yaml. Skills declaring `mcp_servers: [email-outbound]`
 * receive `send` and `track` tools for transactional and marketing email.
 *
 * Provider-pluggable. Today: Resend, Postmark, SendGrid. AWS SES is tracked
 * as a follow-up (needs SDK choice). All providers conform to the
 * EmailProvider interface in `types.ts`, so the MCP entry point stays
 * provider-agnostic — selection happens once at server start (see
 * `provider-select.ts`) and is logged on stderr.
 *
 * Transport: stdio. Wire into a workspace's `.mcp.json` and reference by
 * name from a skill manifest's `mcp_servers` array.
 *
 * Environment:
 *   RESEND_API_KEY                 — Resend bearer token
 *   POSTMARK_SERVER_TOKEN          — Postmark per-server token
 *   SENDGRID_API_KEY               — SendGrid bearer token
 *   EMAIL_OUTBOUND_PROVIDER        — pin a specific provider (optional)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { selectProvider } from "./provider-select.js";
import {
  expandUnsubscribe,
  substituteUnsubscribePlaceholder,
  UnsubscribeError,
  type UnsubscribeOption,
} from "./unsubscribe.js";
import type { SendInput, SendOutput } from "@nexaas/integration-sdk";

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
  unsubscribe: z.union([
    z.literal("auto"),
    z.literal(false),
    z.object({ url: z.string().url() }),
  ]).optional().describe(
    "Unsubscribe handling. \"auto\" mints a per-recipient URL using DASHBOARD_BASE_URL + " +
    "UNSUBSCRIBE_SECRET (or AUTH_SECRET) and adds List-Unsubscribe headers. " +
    "{ url } supplies a static URL (same for all recipients). false suppresses both " +
    "the headers and any URL substitution — caller is responsible for compliance. " +
    "When set, the body's `{{unsubscribe_url}}` placeholder is substituted with the " +
    "per-recipient URL. The MCP fans out one provider call per recipient so each one " +
    "gets its own URL/headers.",
  ),
};

/**
 * Per-recipient send when an unsubscribe option is configured. Each
 * recipient gets a unique URL minted from the framework secret + their
 * email, substituted into body and added to headers. We fan out one
 * provider call per recipient because providers can't substitute body
 * content per-recipient natively (Resend / Postmark / SendGrid all
 * share one body across the full To list). Returns an aggregated
 * SendOutput so the tool response shape is unchanged from the caller's
 * perspective.
 */
async function sendWithUnsubscribe(
  baseInput: SendInput,
  recipients: string[],
  unsubscribe: UnsubscribeOption,
): Promise<SendOutput> {
  const aggregate: SendOutput = { accepted: [], rejected: [] };
  // First message_id wins — typical multi-recipient response pattern.
  // Skills wanting per-recipient ids should split before calling.
  let firstMessageId: string | undefined;

  for (const recipient of recipients) {
    let expansion;
    try {
      expansion = expandUnsubscribe(unsubscribe, recipient);
    } catch (err) {
      // UnsubscribeError → fail the whole batch loudly. Better than silently
      // sending without an unsubscribe link on a marketing send.
      throw err;
    }

    let perRecipient: SendInput = { ...baseInput, to: recipient };
    if (expansion) {
      const substituted = substituteUnsubscribePlaceholder(
        baseInput.body_text,
        baseInput.body_html,
        expansion.url,
      );
      perRecipient = {
        ...perRecipient,
        body_text: substituted.body_text,
        body_html: substituted.body_html,
        headers: { ...(baseInput.headers ?? {}), ...expansion.headers },
      };
    }

    const out = await selected.provider.send(perRecipient);
    if (out.message_id && !firstMessageId) firstMessageId = out.message_id;
    aggregate.accepted.push(...out.accepted);
    aggregate.rejected.push(...out.rejected);
  }

  if (firstMessageId !== undefined) aggregate.message_id = firstMessageId;
  return aggregate;
}

server.tool(
  "send",
  "Send a transactional or marketing email through the workspace's configured provider. " +
  "Returns `message_id` (omitted when *all* recipients were rejected — guard before passing to `track`), " +
  "`accepted` (recipients the provider took), and `rejected` (per-recipient failures with reason). " +
  "Set `unsubscribe: \"auto\"` to inject per-recipient List-Unsubscribe headers + body URL substitution " +
  "(requires DASHBOARD_BASE_URL + UNSUBSCRIBE_SECRET in operator env).",
  sendSchema,
  async (input) => {
    try {
      const recipients = Array.isArray(input.to) ? input.to : [input.to];
      const useFanOut = input.unsubscribe !== undefined && input.unsubscribe !== false;
      const result = useFanOut
        ? await sendWithUnsubscribe(input as SendInput, recipients, input.unsubscribe as UnsubscribeOption)
        : await selected.provider.send(input as SendInput);
      return jsonResult({ ok: true, provider: selected.name, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof UnsubscribeError ? "unsubscribe_misconfigured" : "send_error";
      return jsonResult({ ok: false, provider: selected.name, error: message, code });
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
