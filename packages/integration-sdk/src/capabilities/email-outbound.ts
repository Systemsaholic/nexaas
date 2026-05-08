/**
 * `email-outbound` capability contract (#88).
 *
 * Mirrors the spec in `capabilities/_registry.yaml` (currently v0.2).
 * Integration authors implement `EmailProvider`; the framework's MCP
 * shell handles transport and validation. Skills never see vendor-
 * specific shapes — that's the whole point of the abstraction.
 *
 * Capability-version contract:
 *   This module ships with the framework. An integration declares a
 *   compat range (e.g. ">=0.2 <1") in its nexaas-integration.yaml; the
 *   loader rejects mismatches against the registry's live version.
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
   * guard before passing to `track`.
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
