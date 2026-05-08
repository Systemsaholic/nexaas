/**
 * @nexaas/email-provider-sendgrid — SendGrid implementation of email-outbound.
 *
 * SendGrid's v3 API:
 *   POST /v3/mail/send                       — send (returns 202; no body)
 *
 * Auth: bearer `SENDGRID_API_KEY`.
 *
 * Per-recipient rejection: not surfaced synchronously on send. Bounces
 * and spam complaints arrive via webhook — adopters needing precise
 * outcome should subscribe to SendGrid Event Webhooks. The synchronous
 * call returns 202 + an `X-Message-Id` header on accept, or 4xx with
 * an error body on rejection.
 *
 * Tracking: SendGrid's /v3/messages/<id> endpoint is part of the paid
 * "Email Activity" feature. For a baseline implementation that works
 * without that subscription, `track` returns `status: "unknown"` after
 * confirming the message was queued. Skills needing live engagement
 * should consume webhook events.
 *
 * Migrated from `mcp/servers/email-outbound/src/providers/sendgrid.ts`
 * in #88 Phase 2.
 */

import {
  asArray,
  withTimeout,
  type EmailProvider,
  type SendInput,
  type SendOutput,
  type TrackOutput,
} from "@nexaas/integration-sdk";

const SENDGRID_API = "https://api.sendgrid.com";
const SEND_TIMEOUT_MS = 10_000;
const TRACK_TIMEOUT_MS = 5_000;

interface SendGridErrorResponse {
  errors?: Array<{ message?: string; field?: string }>;
}

interface SendGridMessageDetails {
  msg_id: string;
  status?: string;        // "processed" | "delivered" | "deferred" | "bounce" | "blocked" | "spam_report" | etc.
  last_event_time?: string;
}

function normalizeStatus(status?: string): TrackOutput["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "delivered": return "delivered";
    case "processed":
    case "deferred": return "queued";
    case "bounce":
    case "blocked": return "bounced";
    case "spam_report": return "complained";
    default: return "unknown";
  }
}

export class SendGridProvider implements EmailProvider {
  readonly name = "sendgrid";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("SENDGRID_API_KEY required");
  }

  async send(input: SendInput): Promise<SendOutput> {
    const recipients = asArray(input.to);

    const personalizations: Array<Record<string, unknown>> = [{
      to: recipients.map((email) => ({ email })),
    }];

    const content: Array<{ type: string; value: string }> = [
      // SendGrid requires text/plain BEFORE text/html when both present.
      { type: "text/plain", value: input.body_text },
    ];
    if (input.body_html) content.push({ type: "text/html", value: input.body_html });

    const body: Record<string, unknown> = {
      personalizations,
      from: { email: input.from.email, ...(input.from.name ? { name: input.from.name } : {}) },
      subject: input.subject,
      content,
    };
    if (input.reply_to) body.reply_to = { email: input.reply_to };
    if (input.headers && Object.keys(input.headers).length > 0) body.headers = input.headers;
    if (input.tags && input.tags.length > 0) {
      // SendGrid caps categories at 10 per send — slice defensively.
      body.categories = input.tags.slice(0, 10);
    }
    if (input.tracking) {
      const ts: Record<string, unknown> = {};
      if (input.tracking.opens !== undefined) ts.open_tracking = { enable: input.tracking.opens };
      if (input.tracking.clicks !== undefined) ts.click_tracking = { enable: input.tracking.clicks };
      if (Object.keys(ts).length > 0) body.tracking_settings = ts;
    }
    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => ({
        content: a.content_base64,
        filename: a.filename,
        // SendGrid requires an explicit type; default to octet-stream when
        // unknown so attachments don't fail the schema check.
        type: "application/octet-stream",
      }));
    }

    const res = await withTimeout(
      fetch(`${SENDGRID_API}/v3/mail/send`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      SEND_TIMEOUT_MS,
      "SendGrid send",
    );

    if (res.status === 202) {
      const messageId = res.headers.get("x-message-id") ?? "";
      if (!messageId) {
        // Some SendGrid responses elide the header; record-of-send still
        // succeeded. Fall back to "" — caller can't `track` but the email
        // is in flight. This is a known SendGrid quirk on subuser keys.
        return { accepted: recipients, rejected: [] };
      }
      return {
        message_id: messageId,
        accepted: recipients,
        rejected: [],
      };
    }

    // Non-202 → SendGrid rejected the request. Body shape: {errors: [{message, field}]}
    let reason = `HTTP ${res.status}`;
    try {
      const parsed = await res.json() as SendGridErrorResponse;
      if (parsed.errors && parsed.errors.length > 0) {
        reason = parsed.errors.map((e) => e.message ?? "unknown error").join("; ");
      }
    } catch {
      // body not JSON — keep HTTP status as the reason
    }
    return {
      accepted: [],
      rejected: recipients.map((email) => ({ email, reason })),
    };
  }

  async track(messageId: string): Promise<TrackOutput> {
    // SendGrid's /v3/messages/<id> requires the paid Email Activity feed.
    // We try it once; on 4xx (likely 401/403/404) we fall back to "unknown"
    // with a hint in the WAL via the caller's logging — same shape regardless
    // of whether the account has Activity enabled.
    const res = await withTimeout(
      fetch(`${SENDGRID_API}/v3/messages/${encodeURIComponent(messageId)}`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      }),
      TRACK_TIMEOUT_MS,
      "SendGrid track",
    );

    if (!res.ok) {
      // 401/403 = no Activity feed access; 404 = id unknown; either way the
      // caller gets a graceful "we don't know" instead of an exception.
      return { message_id: messageId, status: "unknown" };
    }

    const data = await res.json() as SendGridMessageDetails;
    const status = normalizeStatus(data.status);

    const out: TrackOutput = {
      message_id: messageId,
      status,
    };
    if (status === "delivered" && data.last_event_time) {
      out.delivered_at = data.last_event_time;
    }
    // Open / click counts come via webhook events; not exposed by this endpoint.
    return out;
  }
}

/**
 * Stable factory export consumed by the email-outbound MCP shell and (in
 * Phase 3) by the manifest-driven loader.
 */
export function createSendGridProvider(apiKey: string): EmailProvider {
  return new SendGridProvider(apiKey);
}
