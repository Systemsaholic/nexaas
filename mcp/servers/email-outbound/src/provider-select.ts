/**
 * Provider selection — env-driven with optional workspace override.
 *
 * Order of resolution:
 *   1. `EMAIL_OUTBOUND_PROVIDER` env var — explicit operator pin
 *   2. `workspace_kv.email_outbound_provider` — runtime override per workspace
 *      (deferred to a follow-up: the MCP runs as its own process and doesn't
 *      have a palace session in scope; for now operators set the env var)
 *   3. First provider whose API key env is present — auto-detect
 *      Probe order: Resend → Postmark → SendGrid (documented & stable so
 *      multi-key workspaces get predictable behavior).
 *
 * Returns the provider instance, the provider name (for WAL / logs), and
 * the reason the provider was picked.
 */

import type { EmailProvider } from "@nexaas/integration-sdk";
import { createResendProvider } from "@nexaas/email-provider-resend";
import { createPostmarkProvider } from "@nexaas/email-provider-postmark";
import { createSendGridProvider } from "@nexaas/email-provider-sendgrid";

export interface SelectedProvider {
  provider: EmailProvider;
  name: string;
  reason: "env_pin" | "auto_detect";
}

export function selectProvider(): SelectedProvider {
  const explicitName = (process.env.EMAIL_OUTBOUND_PROVIDER ?? "").toLowerCase();
  const resendKey = process.env.RESEND_API_KEY;
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  const sendgridKey = process.env.SENDGRID_API_KEY;

  if (explicitName === "resend") {
    if (!resendKey) {
      throw new Error("EMAIL_OUTBOUND_PROVIDER=resend but RESEND_API_KEY is unset");
    }
    return { provider: createResendProvider(resendKey), name: "resend", reason: "env_pin" };
  }

  if (explicitName === "postmark") {
    if (!postmarkToken) {
      throw new Error("EMAIL_OUTBOUND_PROVIDER=postmark but POSTMARK_SERVER_TOKEN is unset");
    }
    return { provider: createPostmarkProvider(postmarkToken), name: "postmark", reason: "env_pin" };
  }

  if (explicitName === "sendgrid") {
    if (!sendgridKey) {
      throw new Error("EMAIL_OUTBOUND_PROVIDER=sendgrid but SENDGRID_API_KEY is unset");
    }
    return { provider: createSendGridProvider(sendgridKey), name: "sendgrid", reason: "env_pin" };
  }

  if (explicitName) {
    throw new Error(
      `EMAIL_OUTBOUND_PROVIDER=${explicitName} not yet supported by this build. ` +
      `Available: resend, postmark, sendgrid. AWS SES is tracked as a follow-up to #78.`,
    );
  }

  // Auto-detect — first key wins. Order is documented in the README so
  // behavior is predictable when multiple keys are present.
  if (resendKey) {
    return { provider: createResendProvider(resendKey), name: "resend", reason: "auto_detect" };
  }
  if (postmarkToken) {
    return { provider: createPostmarkProvider(postmarkToken), name: "postmark", reason: "auto_detect" };
  }
  if (sendgridKey) {
    return { provider: createSendGridProvider(sendgridKey), name: "sendgrid", reason: "auto_detect" };
  }

  throw new Error(
    "No email-outbound provider configured. Set one of RESEND_API_KEY, POSTMARK_SERVER_TOKEN, " +
    "or SENDGRID_API_KEY (or set EMAIL_OUTBOUND_PROVIDER and the matching key) in the workspace .env. See #78.",
  );
}
