/**
 * Postmark provider plugin (#78 PR B).
 *
 * Postmark's HTTP API:
 *   POST /email                              — send a single message
 *   GET  /messages/outbound/<id>/details     — fetch delivery state
 *
 * Auth: `X-Postmark-Server-Token` header (per-server-token API).
 *
 * Multi-recipient handling: Postmark accepts a comma-separated `To`
 * field on /email and returns one MessageID for the batch. For richer
 * per-recipient outcomes we'd use /email/batch — deferred to a follow-up
 * since the framework's `rejected` shape can be derived from the
 * single-call response when ErrorCode != 0.
 *
 * Tracking: Postmark exposes per-message metadata at
 * /messages/outbound/<id>/details — including last status, recorded
 * delivery time, and bounce details. Open/click counts come from
 * /opens and /clicks endpoints; we return aggregate state only here
 * to avoid three round-trips per `track` call.
 */

import type { EmailProvider, SendInput, SendOutput, TrackOutput } from "../types.js";

const POSTMARK_API = "https://api.postmarkapp.com";
const SEND_TIMEOUT_MS = 10_000;
const TRACK_TIMEOUT_MS = 5_000;

interface PostmarkSendResponse {
  To?: string;
  MessageID?: string;
  ErrorCode?: number;
  Message?: string;
  SubmittedAt?: string;
}

interface PostmarkMessageDetails {
  MessageID: string;
  Status?: string;        // "Sent" | "Bounced" | "Spam" | "Inactive" | "Pending"
  ReceivedAt?: string;
  Recipients?: string[];
  MessageEvents?: Array<{
    Recipient?: string;
    Type?: string;        // "Delivered" | "Opened" | "LinkClicked" | "Bounced" | "Transient" | "SpamComplaint" | etc.
    ReceivedAt?: string;
    Details?: { Type?: string; Description?: string };
  }>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function formatFrom(input: SendInput["from"]): string {
  return input.name ? `${input.name} <${input.email}>` : input.email;
}

/**
 * Postmark's tracking flag for clicks is a string enum:
 *   "None" | "HtmlAndText" | "HtmlOnly" | "TextOnly"
 * We map our boolean to "HtmlAndText" (the most permissive useful value)
 * when enabled. Adopters needing finer control bypass tracking input and
 * configure the Postmark server defaults.
 */
function trackLinksValue(enabled: boolean | undefined): string | undefined {
  if (enabled === undefined) return undefined;
  return enabled ? "HtmlAndText" : "None";
}

/**
 * Map Postmark's last-known message Status to the framework's enum.
 * Postmark uses different vocabulary; the framework normalizes so skills
 * don't need provider-specific switch statements.
 */
function normalizeStatus(status?: string, events?: PostmarkMessageDetails["MessageEvents"]): TrackOutput["status"] {
  // Prefer the most specific event in the timeline.
  if (events && events.length > 0) {
    const lastEvent = events[events.length - 1];
    if (lastEvent.Type === "Delivered") return "delivered";
    if (lastEvent.Type === "Bounced" || lastEvent.Type === "Transient") return "bounced";
    if (lastEvent.Type === "SpamComplaint") return "complained";
  }
  // Fall back to the top-level Status field.
  switch ((status ?? "").toLowerCase()) {
    case "sent": return "sent";
    case "bounced": return "bounced";
    case "spam": return "complained";
    case "pending": return "queued";
    case "inactive": return "bounced";
    default: return "unknown";
  }
}

export class PostmarkProvider implements EmailProvider {
  readonly name = "postmark";

  constructor(private readonly serverToken: string) {
    if (!serverToken) throw new Error("POSTMARK_SERVER_TOKEN required");
  }

  async send(input: SendInput): Promise<SendOutput> {
    const recipients = asArray(input.to);

    const body: Record<string, unknown> = {
      From: formatFrom(input.from),
      To: recipients.join(", "),     // comma-separated per Postmark API
      Subject: input.subject,
      TextBody: input.body_text,
    };
    if (input.body_html) body.HtmlBody = input.body_html;
    if (input.reply_to) body.ReplyTo = input.reply_to;
    if (input.headers && Object.keys(input.headers).length > 0) {
      body.Headers = Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value }));
    }
    if (input.tracking?.opens !== undefined) body.TrackOpens = input.tracking.opens;
    const tl = trackLinksValue(input.tracking?.clicks);
    if (tl !== undefined) body.TrackLinks = tl;
    // Postmark's `Tag` field is singular (one string). We use the first
    // entry from the framework's tags array; additional tags are dropped
    // with a comment since Postmark provides Metadata instead — we put
    // the rest there for filterability.
    if (input.tags && input.tags.length > 0) {
      body.Tag = input.tags[0];
      if (input.tags.length > 1) {
        body.Metadata = Object.fromEntries(
          input.tags.slice(1).map((t, i) => [`tag_${i + 1}`, t]),
        );
      }
    }
    if (input.attachments && input.attachments.length > 0) {
      body.Attachments = input.attachments.map((a) => ({
        Name: a.filename,
        Content: a.content_base64,
        ContentType: "application/octet-stream",
      }));
    }

    const res = await withTimeout(
      fetch(`${POSTMARK_API}/email`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.serverToken,
        },
        body: JSON.stringify(body),
      }),
      SEND_TIMEOUT_MS,
      "Postmark send",
    );

    let parsed: PostmarkSendResponse;
    try {
      parsed = await res.json() as PostmarkSendResponse;
    } catch {
      throw new Error(`Postmark returned non-JSON response (HTTP ${res.status})`);
    }

    // Postmark uses ErrorCode = 0 for success, non-zero for failure. The
    // top-level HTTP status mirrors this in most cases.
    if (!res.ok || (parsed.ErrorCode !== undefined && parsed.ErrorCode !== 0)) {
      const reason = parsed.Message ?? `HTTP ${res.status} (Postmark ErrorCode ${parsed.ErrorCode ?? "unknown"})`;
      return {
        accepted: [],
        rejected: recipients.map((email) => ({ email, reason })),
      };
    }

    if (!parsed.MessageID) {
      throw new Error("Postmark response missing MessageID");
    }

    return {
      message_id: parsed.MessageID,
      accepted: recipients,
      rejected: [],
    };
  }

  async track(messageId: string): Promise<TrackOutput> {
    const res = await withTimeout(
      fetch(`${POSTMARK_API}/messages/outbound/${encodeURIComponent(messageId)}/details`, {
        headers: {
          "Accept": "application/json",
          "X-Postmark-Server-Token": this.serverToken,
        },
      }),
      TRACK_TIMEOUT_MS,
      "Postmark track",
    );

    if (res.status === 404) {
      return { message_id: messageId, status: "unknown" };
    }
    if (!res.ok) {
      throw new Error(`Postmark track HTTP ${res.status}`);
    }

    const data = await res.json() as PostmarkMessageDetails;
    const status = normalizeStatus(data.Status, data.MessageEvents);

    const out: TrackOutput = {
      message_id: messageId,
      status,
    };

    // Find the Delivered event timestamp, if any.
    const deliveredEvent = data.MessageEvents?.find((e) => e.Type === "Delivered");
    if (deliveredEvent?.ReceivedAt) {
      out.delivered_at = deliveredEvent.ReceivedAt;
    } else if (data.ReceivedAt && status === "sent") {
      out.delivered_at = data.ReceivedAt;
    }

    if (status === "bounced") {
      const bounceEvent = data.MessageEvents?.find((e) => e.Type === "Bounced" || e.Type === "Transient");
      if (bounceEvent) {
        out.bounced = {
          at: bounceEvent.ReceivedAt ?? new Date().toISOString(),
          type: bounceEvent.Details?.Type ?? "unknown",
          reason: bounceEvent.Details?.Description,
        };
      }
    }

    // Open / click counts require separate /opens and /clicks endpoint
    // calls per recipient — three round-trips per `track`. Skipped here
    // to keep `track` cheap; skills needing engagement should subscribe
    // to Postmark webhooks. Documented in the server README.
    return out;
  }
}
