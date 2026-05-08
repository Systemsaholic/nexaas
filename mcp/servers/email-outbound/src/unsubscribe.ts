/**
 * Per-recipient unsubscribe URL minting (#82).
 *
 * Adopters who send marketing email need a List-Unsubscribe header and
 * (typically) an in-body unsubscribe URL. Doing this inside the skill
 * prompt is awkward (the LLM does crypto), brittle (per-recipient
 * multiplied chance of malformed output), and forces the receiver's
 * HMAC secret into prompt context. This module handles the expansion
 * inside the MCP server instead — secret stays in operator env, the
 * skill just sets `unsubscribe: "auto"` on the send call.
 *
 * Receiver contract (matches what the Nexmatic dashboard implements but
 * is not Nexmatic-specific — any adopter who runs a URL/token-verifying
 * receiver can use this):
 *
 *   URL:    `<DASHBOARD_BASE_URL>/unsubscribe?e=<encodedEmail>&t=<token>`
 *   email:  base64url(utf8(email.trim().toLowerCase()))
 *   token:  base64url(HMAC-SHA256(SECRET, "unsubscribe:" + normalizedEmail).digest().subarray(0, 16))
 *
 * The receiver verifies by recomputing the token from the same secret +
 * normalized email and timing-safe-comparing. Email normalization
 * (trim + lowercase) is mandatory on both sides — without it,
 * `Foo@Bar.com` and `foo@bar.com` produce different tokens.
 *
 * Direct adopters who don't run the Nexmatic dashboard can self-host the
 * receiver: implement `/unsubscribe` with the same secret + verify
 * routine, and point `DASHBOARD_BASE_URL` at it.
 */

import { createHmac } from "crypto";

const TOKEN_BYTES = 16;

/** Operator-set base URL of the unsubscribe receiver, e.g. https://app.acme.com */
function dashboardBase(): string | null {
  return process.env.DASHBOARD_BASE_URL ?? null;
}

/** HMAC secret. Falls back to AUTH_SECRET to match the Nexmatic receiver's resolution. */
function unsubscribeSecret(): string | null {
  return (
    process.env.UNSUBSCRIBE_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    null
  );
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function signUnsubscribeToken(email: string, secret: string): string {
  const mac = createHmac("sha256", secret)
    .update(`unsubscribe:${normalizeEmail(email)}`)
    .digest();
  return b64url(mac.subarray(0, TOKEN_BYTES));
}

export function buildUnsubscribeUrl(email: string, base: string, secret: string): string {
  const e = b64url(Buffer.from(normalizeEmail(email), "utf-8"));
  const t = signUnsubscribeToken(email, secret);
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/unsubscribe?e=${e}&t=${t}`;
}

export type UnsubscribeOption =
  | "auto"
  | false
  | { url: string };

export interface UnsubscribeExpansion {
  /** The per-recipient URL to substitute into body and headers. */
  url: string;
  /** Headers to add (List-Unsubscribe + List-Unsubscribe-Post per RFC 8058 one-click). */
  headers: Record<string, string>;
}

export class UnsubscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsubscribeError";
  }
}

/**
 * Resolve the per-recipient unsubscribe URL + headers for one message.
 *
 * Throws `UnsubscribeError` for `"auto"` requests when DASHBOARD_BASE_URL
 * or UNSUBSCRIBE_SECRET is missing — silent omission of an unsubscribe
 * link on a marketing send is a CAN-SPAM / CASL violation, so we'd rather
 * fail loudly. Returns `null` when the option itself is `false` (caller
 * is opting out and is responsible for its own compliance).
 */
export function expandUnsubscribe(
  option: UnsubscribeOption | undefined,
  recipient: string,
): UnsubscribeExpansion | null {
  if (option === undefined || option === false) return null;

  let url: string;
  if (option === "auto") {
    const base = dashboardBase();
    const secret = unsubscribeSecret();
    if (!base) {
      throw new UnsubscribeError(
        "unsubscribe: \"auto\" requires DASHBOARD_BASE_URL — set it in the worker .env",
      );
    }
    if (!secret) {
      throw new UnsubscribeError(
        "unsubscribe: \"auto\" requires UNSUBSCRIBE_SECRET (or AUTH_SECRET) — set it in the worker .env",
      );
    }
    url = buildUnsubscribeUrl(recipient, base, secret);
  } else {
    if (typeof option.url !== "string" || option.url.length === 0) {
      throw new UnsubscribeError("unsubscribe: { url } requires a non-empty string");
    }
    url = option.url;
  }

  return {
    url,
    headers: {
      "List-Unsubscribe": `<${url}>`,
      // RFC 8058 one-click — receiver must support POST with this body to
      // count as one-click compliant per Gmail/Yahoo bulk-sender rules.
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * Substitute `{{unsubscribe_url}}` into both body_text and body_html.
 * Returns a new pair of strings; never mutates the inputs. Skills that
 * don't include the placeholder still get the headers (which is enough
 * for compliance even without an in-body link).
 */
export function substituteUnsubscribePlaceholder(
  bodyText: string,
  bodyHtml: string | undefined,
  url: string,
): { body_text: string; body_html?: string } {
  const replaceAll = (s: string) => s.split("{{unsubscribe_url}}").join(url);
  return {
    body_text: replaceAll(bodyText),
    body_html: bodyHtml === undefined ? undefined : replaceAll(bodyHtml),
  };
}
