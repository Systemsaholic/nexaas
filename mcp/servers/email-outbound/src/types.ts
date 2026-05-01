/**
 * Shared types between the MCP entry point and provider plugins.
 *
 * Mirrors the email-outbound capability v0.2 spec in
 * capabilities/_registry.yaml. The MCP entry point validates input via zod
 * before handing off to a provider; the provider's job is to translate
 * these framework-canonical fields into whatever the underlying API
 * expects, then translate the response back into the canonical output
 * shape. Skills never see provider-specific shapes.
 */

export interface SendInput {
  from: { email: string; name?: string };
  reply_to?: string;
  to: string | string[];
  subject: string;
  body_text: string;
  body_html?: string;
  headers?: Record<string, string>;
  tracking?: { opens?: boolean; clicks?: boolean };
  tags?: string[];
  attachments?: Array<{ filename: string; content_base64: string }>;
}

export interface SendOutput {
  /**
   * Provider's native id for the accepted message. Undefined when *all*
   * recipients were rejected (no message exists to track). Skills should
   * guard before passing to `track`. PR #79 review.
   */
  message_id?: string;
  accepted: string[];
  rejected: Array<{ email: string; reason: string }>;
}

export interface TrackOutput {
  message_id: string;
  status: "queued" | "sent" | "delivered" | "bounced" | "complained" | "unknown";
  delivered_at?: string;
  opened?: { count: number; last_at?: string };
  clicked?: { count: number; last_at?: string };
  bounced?: { at: string; type: string; reason?: string };
}

export interface EmailProvider {
  /** Stable identifier — `resend`, `postmark`, `sendgrid`, `aws_ses`. Surfaces in WAL & logs. */
  readonly name: string;

  send(input: SendInput): Promise<SendOutput>;

  track(messageId: string): Promise<TrackOutput>;
}
