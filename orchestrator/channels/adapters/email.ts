/**
 * Email Channel Adapter — delivers via SMTP/Gmail/IMAP.
 *
 * Uses the email MCP server if available, falls back to SMTP.
 * For now: logs the delivery intent. Full MCP integration in Sprint 3+.
 */

import { logger } from "@trigger.dev/sdk/v3";

export interface EmailDeliveryPayload {
  to: string;
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
  html?: boolean;
}

export async function deliverViaEmail(payload: EmailDeliveryPayload): Promise<boolean> {
  // TODO: Wire to email MCP server or direct SMTP
  // For now, log the intent — the skill already handles email via MCP tools
  logger.info(`Email delivery: to=${payload.to} subject="${payload.subject}"`);
  logger.info(`Email body preview: ${payload.body.slice(0, 200)}`);

  // In production: use the email MCP server's send tool
  // const result = await mcpCall("email", "send", { to, subject, body, from });

  return true;
}
