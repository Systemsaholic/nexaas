/**
 * Resend provider plugin.
 *
 * Resend's HTTP API is small enough that a fetch-based client is simpler
 * than pulling in their SDK. Two endpoints used:
 *
 *   POST https://api.resend.com/emails        — send a single email
 *   GET  https://api.resend.com/emails/:id    — fetch state for tracking
 *
 * Auth: bearer `RESEND_API_KEY`.
 *
 * Tracking: Resend tracks opens/clicks server-side when toggles are passed.
 * The GET endpoint returns last-known status but engagement counts come
 * via webhooks — we surface what the email-fetch endpoint exposes
 * (`last_event` / `created_at` / `delivered_at`) and leave count granularity
 * to a future webhook-receiver task. This keeps the framework-side
 * implementation stateless; skills that need precise open/click counts
 * should listen to the webhook drawer and aggregate themselves.
 */

import type { EmailProvider, SendInput, SendOutput, TrackOutput } from "../types.js";

const RESEND_API = "https://api.resend.com";
const SEND_TIMEOUT_MS = 10_000;
const TRACK_TIMEOUT_MS = 5_000;

interface ResendSendResponse {
  id?: string;
  // Resend's error envelope
  name?: string;
  message?: string;
  statusCode?: number;
}

interface ResendEmailLookup {
  id: string;
  created_at?: string;
  // last_event values: queued | sent | delivered | delivery_delayed |
  // bounced | complained | failed
  last_event?: string;
  // delivered_at present once the provider confirms delivery
  delivered_at?: string;
  // bounce details when last_event = bounced
  bounced_at?: string;
  bounce?: { type?: string; message?: string };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function formatFrom(input: SendInput["from"]): string {
  return input.name ? `${input.name} <${input.email}>` : input.email;
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function normalizeStatus(lastEvent?: string): TrackOutput["status"] {
  switch (lastEvent) {
    case "queued":
    case "sent":
    case "delivered":
    case "bounced":
    case "complained":
      return lastEvent;
    case "delivery_delayed":
    case "failed":
      return "bounced";
    default:
      return "unknown";
  }
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend";

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("RESEND_API_KEY required");
  }

  async send(input: SendInput): Promise<SendOutput> {
    const recipients = asArray(input.to);

    const body: Record<string, unknown> = {
      from: formatFrom(input.from),
      to: recipients,
      subject: input.subject,
      text: input.body_text,
    };
    if (input.body_html) body.html = input.body_html;
    if (input.reply_to) body.reply_to = input.reply_to;
    if (input.headers && Object.keys(input.headers).length > 0) body.headers = input.headers;
    if (input.tags && input.tags.length > 0) {
      body.tags = input.tags.map((name) => ({ name }));
    }
    if (input.attachments && input.attachments.length > 0) {
      body.attachments = input.attachments.map((a) => ({
        filename: a.filename,
        content: a.content_base64,
      }));
    }
    // Resend doesn't accept per-message tracking toggles — opens & clicks
    // are configured at the API-key / domain level. We accept the fields
    // for cross-provider symmetry but no-op them here. Documented in the
    // server README so adopters know to flip toggles in the Resend dashboard.

    const res = await withTimeout(
      fetch(`${RESEND_API}/emails`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      SEND_TIMEOUT_MS,
      "Resend send",
    );

    let parsed: ResendSendResponse;
    try {
      parsed = await res.json() as ResendSendResponse;
    } catch {
      throw new Error(`Resend returned non-JSON response (HTTP ${res.status})`);
    }

    if (!res.ok) {
      // Resend bundles all rejections into a single error — we surface as
      // "all recipients rejected with the provider message" since per-
      // recipient rejection is not in the API response. `message_id` is
      // omitted (undefined) — there is no message to track. PR #79 review.
      const reason = parsed.message ?? `HTTP ${res.status}`;
      return {
        accepted: [],
        rejected: recipients.map((email) => ({ email, reason })),
      };
    }

    if (!parsed.id) {
      throw new Error("Resend response missing id");
    }

    return {
      message_id: parsed.id,
      accepted: recipients,
      rejected: [],
    };
  }

  async track(messageId: string): Promise<TrackOutput> {
    const res = await withTimeout(
      fetch(`${RESEND_API}/emails/${encodeURIComponent(messageId)}`, {
        headers: { "Authorization": `Bearer ${this.apiKey}` },
      }),
      TRACK_TIMEOUT_MS,
      "Resend track",
    );

    if (res.status === 404) {
      return { message_id: messageId, status: "unknown" };
    }
    if (!res.ok) {
      throw new Error(`Resend track HTTP ${res.status}`);
    }

    const data = await res.json() as ResendEmailLookup;
    const status = normalizeStatus(data.last_event);

    const out: TrackOutput = {
      message_id: messageId,
      status,
    };
    if (data.delivered_at) out.delivered_at = data.delivered_at;
    if (status === "bounced" && data.bounced_at) {
      out.bounced = {
        at: data.bounced_at,
        type: data.bounce?.type ?? "unknown",
        reason: data.bounce?.message,
      };
    }
    // Open / click counts are webhook-delivered; not exposed by GET /emails/:id.
    // Leave `opened` / `clicked` undefined to signal "not yet known" per the
    // capability spec contract.
    return out;
  }
}
