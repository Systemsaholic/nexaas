/**
 * Resend Email Client — transactional email delivery for Nexmatic.
 *
 * Powers all @nexmatic.ca emails: platform notifications, instance alerts,
 * approval requests, registration, and billing.
 *
 * NOT for client email automation (that's the Email MCP — future work).
 */

import { Resend } from "resend";
import { logger } from "@trigger.dev/sdk/v3";

const RESEND_API_KEY = process.env.RESEND_API_KEY;

let _client: Resend | null = null;

function getClient(): Resend {
  if (!_client) {
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY environment variable is required");
    }
    _client = new Resend(RESEND_API_KEY);
  }
  return _client;
}

/** Default from addresses by purpose */
export const FROM = {
  noreply: "Nexmatic <noreply@nexmatic.ca>",
  alert: "Nexmatic Alerts <alert@nexmatic.ca>",
} as const;

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  from?: string;
  replyTo?: string;
  cc?: string[];
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  try {
    const client = getClient();

    const { data, error } = await client.emails.send({
      from: options.from ?? FROM.noreply,
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      cc: options.cc,
    });

    if (error) {
      logger.error(`Resend API error: ${error.message}`);
      return { success: false, error: error.message };
    }

    logger.info(`Email sent via Resend: ${data?.id} → ${options.to}`);
    return { success: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Resend send failed: ${msg}`);
    return { success: false, error: msg };
  }
}
